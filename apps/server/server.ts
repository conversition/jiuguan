/**
 * Web API 服务（前后端软件的后端）
 * 聚合 core/memory/prompt/proxy/variable 包，暴露 REST + SSE API：
 *   GET  /api/cards                 → 可用角色卡列表
 *   GET  /api/sessions              → 已有会话（DB 文件，含摘要名）
 *   POST /api/session/new           {card} → SSE：创建会话（阶段进度：card→worldbook→ready；检索后台预热）
 *   POST /api/session/resume        {db}   → 恢复会话
 *   POST /api/turn                  {session, input, content_mode} → SSE：状态 + 模拟流式正文
 *   GET  /api/session/:id/history   → 会话历史（chat_log）
 *   GET  /api/session/:id/mvu-state → MVU 权威状态快照（state + stateVersion + ready）
 *   POST /api/session/:id/mvu-update {ops, expectedVersion} → 结构化更新（乐观锁冲突 → 409）
 * 会话实例进程内 Map + DB 文件持久化。
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, existsSync, readFileSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ChatSession,
  StoryIndexGenerationUnavailableError,
} from '../../tools/cli/session.ts';
import type { BranchSelectionReference, ImageAttachment } from '../../tools/cli/session.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import {
  aggregateSessionSnapshot,
  computeSessionDatabaseSnapshot,
  type SessionAssetRevision,
  type SessionSnapshot,
} from '../../packages/memory/src/session-snapshot.ts';
import { PluginRegistry, type PluginUpdateTransaction } from '../../packages/plugin/src/registry.ts';
import { toPublicPluginRecord } from '../../packages/plugin/src/public-record.ts';
import { DshPluginHost } from '../../packages/plugin/src/dsh-host.ts';
import {
  AssetRevisionConflictError,
  deleteUserAssetCas,
  deleteUserCardCas,
  deleteWorldbookFileCas,
  listAssets,
  listCards,
  readAsset,
  readCardText,
  readRevisionedAsset,
  readRevisionedCard,
  resolveCard,
  saveAssetBuffer,
  saveUserAssetCas,
  isSafeAssetFileName,
} from '../../packages/core/src/asset-paths.ts';
import {
  AssetIdentityRegistry,
  type LocalAssetIdentity,
} from '../../packages/core/src/asset-identity.ts';
import { parseWorldBook } from '../../packages/core/src/worldbook.ts';
import { parsePreset } from '../../packages/core/src/preset.ts';
import { parseCharaCard, extractCharaFromPng, pngPayloadToJson, buildCharaPng } from '../../packages/core/src/chara.ts';
import { RegexLibrary } from '../../packages/core/src/regex-library.ts';
import { StoryboardOrchestrator, StoryboardRegistry, DEFAULT_WORKFLOW } from '../../tools/cli/storyboard-orchestrator.ts';
import type { StoryboardResult } from '../../tools/cli/storyboard-orchestrator.ts';
import { VideoPromptGenerator } from '../../tools/cli/video-prompt-generator.ts';
import type { VideoPromptResult } from '../../tools/cli/video-prompt-generator.ts';
import { renderDirectorMarkdown, safeParseStage, PanelsSchemaLenient } from '../../packages/prompt/src/storyboard.ts';
import type { Panel } from '../../packages/prompt/src/storyboard.ts';
import { OpenAICompatibleClient, type ChatCompletionClient } from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady, readLocalEnvCredential } from '../../packages/proxy/src/config.ts';
import {
  ProviderRegistry,
  ProviderRegistryError,
} from '../../packages/proxy/src/provider-registry.ts';
import { createRegistryProviderClient } from '../../packages/proxy/src/provider-client.ts';
import { createOpenAIProviderController } from '../../packages/proxy/src/openai-provider.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { HashEmbeddingProvider, createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { LearnedStyleProposalStore, type StyleProposal } from '../../packages/core/src/learned-style-store.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import {
  DiskCache,
  DEFAULT_ASSETS_DIR,
  loadManifest,
  saveManifest,
  mergeAssetIndex,
  downloadAll,
  MAX_ASSET_DOWNLOAD_BYTES,
  mimeForUrl,
} from '../../packages/assets/src/downloader.ts';
import { buildAssetIndex, countByKind, classifyAsset, entryName, assetId, normalizeUrl } from '../../packages/assets/src/build-index.ts';
import { safeFetchBuffer, validateSafeFetchUrl } from '../../packages/assets/src/safe-fetch.ts';
import { analyzeQualityDb, scanSessionDbs } from '../../tools/cli/quality.ts';
import { readAdaptiveConfig, writeAdaptiveConfig } from '../../packages/prompt/src/adaptive.ts';
import {
  BODY_LIMITS,
  BodyDeadlineError,
  PayloadTooLargeError,
  assertContentLength,
  bodyLimitForPath,
  readLimitedBody,
  resolveSessionDatabase,
} from './security.ts';
import {
  AuthRuntime,
  extractCsrfToken,
  extractPresentedCredential,
  parseAccessMode,
  SESSION_COOKIE_NAME,
  type AuthenticatedContext,
} from './auth-runtime.ts';
import { AuthenticatedStreamRegistry } from './auth-stream-registry.ts';
import { decideRouteAccess, matchRouteAccess } from './route-access.ts';
import { parseStoryIndexPostBody } from './story-index-request.ts';
import {
  PairingAdmissionController,
  RequestAdmissionController,
  bindAdmissionLease,
  type ProtectedRateGroup,
} from './rate-limit.ts';
import {
  SecurityAuditSpan,
  SecurityAuditWriter,
} from './security-audit.ts';
import {
  API_PROTOCOL_VERSION,
  CAPACITOR_APP_ORIGIN,
  ABSENT_REVISION,
  EXPECTED_REVISION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  MAX_CLIENT_PROTOCOL_VERSION,
  MIN_CLIENT_PROTOCOL_VERSION,
  REQUEST_ID_HEADER,
  REVISION_HEADER,
  formatStrongEtag,
  isEntityRevision,
  parseIfMatch,
  isAssetCapabilityRequest,
  isAssetDownloadRequest,
  isIssuePairingCodeRequest,
  isSafeOpaqueId,
  type AssetCapabilityPurpose,
  type AssetDownloadGrant,
  type AssetDownloadFormat,
  type ApiErrorCode,
  type ApiErrorPayload,
  type LocalAssetDescriptor,
  type LocalAssetImportResult,
  type PublicAssetDescriptor,
  type ServerMeta,
} from '../../packages/mobile-contracts/src/index.ts';
import {
  buildLocalExactAuthorities,
  buildLocalExactOrigins,
  createExactOriginAllowlist,
  evaluateHttpAuthority,
  evaluateHttpPolicy,
  parseDevWebPort,
  parsePublicHttpsOrigins,
  shouldAllowOpaqueAssetCors,
} from './http-policy.ts';
import {
  assertAppOriginsDisjoint,
  evaluateCorsPreflight,
  parseAppOrigins,
} from './cors-preflight.ts';
import { evaluateCorsActual } from './cors-actual.ts';
import { applyActualCorsHeaders } from './cors-response.ts';
import { serveStaticWeb } from './static-web.ts';
import { rawEntriesOf, toTavernHelperEntry, applyChangedEntries, type TavernHelperEntry } from './worldbook-bridge.ts';
import { loadOrCreateInstallationIdentity } from './installation-identity.ts';
import { TurnJobConflictError } from './turn-job-manager.ts';
import { TurnJobAdmissionError, TurnJobService } from './turn-job-service.ts';
import { InvalidationHub } from './event-hub.ts';
import { AgentLearningLedger } from './agent-learning-ledger.ts';
import { LearningOutboxDrainer } from './learning-outbox-drainer.ts';
import { runSettledLearningBarrier } from './settled-learning-barrier.ts';
import {
  opaqueLearningToken,
  PreferenceClearOperationIntentConflictError,
  sha256Digest,
} from '../../packages/memory/src/learning-outbox.ts';
import {
  readSessionEffectiveLearning,
  readSessionLearningIdentity,
  readSessionPreferenceEvidenceState,
  readSessionPreferenceSyncState,
} from './session-learning-identity.ts';
import type { EventEnvelope, EventType } from '../../packages/mobile-contracts/src/index.ts';
import { acquireServerProcessLock } from './process-lock.ts';
import {
  ASSET_UPLOAD_LIMITS,
  AssetUploadError,
  discardAssetUpload,
  pruneAssetUploadTemps,
  receiveAssetMultipart,
  type ReceivedAssetUpload,
} from './multipart-upload.ts';
import {
  AssetContentValidationError,
  validateAssetContent,
} from './asset-content-validation.ts';
import { AssetImportTransactionCoordinator } from './asset-import-transaction.ts';
import { contentDisposition, prepareAssetDownload } from './asset-download.ts';
import { SnapshotCoordinator } from './snapshot-coordinator.ts';
import { buildDefaultSnapshotInventory } from './snapshot-inventory.ts';
import { SynchronousSnapshotFreezeAdapter } from './snapshot-freeze.ts';
import { SqliteOnlineSnapshotAdapter } from './snapshot-sqlite.ts';
import {
  readSnapshotRestorePendingMarker,
  recoverSnapshotRestoreBeforeServerLock,
} from './snapshot-restore.ts';
import { SessionDeletionJournal } from './session-deletion-journal.ts';
import { MaintenanceJobManager, MaintenanceDisabledError } from './maintenance-job-manager.ts';
import { MaintenanceHarnessService } from './maintenance-harness-service.ts';
import { MaintenanceProposalControl } from './maintenance-proposal-control.ts';
import { createNpcMaintenanceProposalAdapters } from './npc-maintenance-proposal-adapter.ts';
import {
  maintenanceApplyAllowsSession,
  maintenanceProposalApplySupported,
  parseMaintenanceApplyRuntimeConfig,
} from './maintenance-apply-runtime-config.ts';
import { createAdmittedMaintenanceModel } from './admitted-maintenance-model.ts';
import {
  maintenanceBudgetProfileForAutonomy,
  maintenanceCostEstimator,
  parseMaintenanceRuntimeConfig,
} from './maintenance-runtime-config.ts';
import { buildMaintenanceSessionSnapshot } from './maintenance-session-snapshot.ts';
import {
  MAINTENANCE_POLICY,
  MAINTENANCE_POLICY_VERSION,
  isMaintenanceTaskKind,
} from './maintenance-types.ts';
import { InteractiveCallLedger } from './interactive-call-ledger.ts';
import {
  foregroundSummaryBudgetProfile,
  interactiveBudgetProfileForAutonomy,
  parseInteractiveRuntimeConfig,
} from './interactive-runtime-config.ts';
import { resolveModelRuntimeProfile } from '../../packages/prompt/src/model-runtime-profile.ts';
import {
  contextCompilerAllowsSession,
  parseContextCompilerRuntimeConfig,
} from './context-compiler-runtime-config.ts';
import { agentTaskBudgetProfile } from './agent-task-budget-profiles.ts';
import { ModelUsageLedger } from './model-usage-ledger.ts';
import { AgentAdmissionLedger, AGENT_ADMISSION_DB_FILE } from './agent-admission-ledger.ts';
import { readSessionAgentControl } from './agent-control-api.ts';
import { agentCapabilityTicketAllowed } from './agent-capability-binding.ts';
import {
  evaluateAgentTicketBeginPolicy,
  rolloutLaneForAdmission,
} from './agent-begin-policy.ts';
import {
  applyAgentControlMutation,
  authorizeAgentControlMutation,
  parseAgentControlMutation,
  parseAgentControlMutationRuntimeConfig,
} from './agent-control-mutation.ts';
import {
  WORLDBOOK_REPAIR_DB_FILE,
  WorldbookRepairControl,
} from './worldbook-repair-control.ts';
import { WorldbookRepairControlPlane } from './worldbook-repair-control-plane.ts';
import {
  parseWorldbookRepairRuntimeConfig,
} from './worldbook-repair-runtime-config.ts';
import {
  agentAdmissionAllowsSession,
  parseAgentAdmissionRuntimeConfig,
} from './agent-admission-runtime-config.ts';
import { parseLearningTextRuntimeConfig } from './learning-text-runtime-config.ts';
import { AdmissionTicketBroker } from './agent-admission-broker.ts';
import {
  AdmittedModelGateway,
  type AdmittedModelLeaseAudit,
} from './admitted-model-gateway.ts';
import {
  admissionRequestDigest,
  admissionLimitsFromBudgetProfile,
  agentToolSetDigest,
} from '../../packages/agent-policy/src/admission.ts';
import {
  agentBudgetProfileDigest,
} from '../../packages/agent-policy/src/budget-profile.ts';
import {
  parseLearnedStyleModelResponse,
  STYLE_DRAFT_TOOL_NAME,
} from '../../packages/agent-policy/src/style-compiler.ts';
import { evaluateLearnedStyleDraft } from '../../packages/agent-policy/src/style-evaluator.ts';
import {
  selectArcSessionProjection,
  selectNpcSessionProjection,
} from '../../packages/agent-policy/src/domain-projection-contract.ts';
import { INTERACTIVE_NATIVE_TOOLS } from '../../packages/harness/src/interactive-tools.ts';
import {
  CONTEXT_COMPILER_POLICY_VERSION,
  ContextCapsuleCache,
  buildContextCompilerModelRequest,
  contextCompilerSourceDigest,
  parseContextCapsule,
  partitionContextCompilerSources,
} from '../../packages/harness/src/context-compiler.ts';
import { buildPrecommitCriticModelRequest } from '../../packages/harness/src/precommit-critic-model.ts';
import {
  buildBranchAttributionModelRequest,
  buildPreferenceExtractionModelRequest,
  buildStyleCompilationModelRequest,
} from '../../packages/harness/src/learning-model-contract.ts';
import {
  maintenanceAdmissionAllowsSession,
  parseMaintenanceAdmissionRuntimeConfig,
} from './maintenance-admission-runtime-config.ts';
import { buildMaintenanceAdmissionAudits } from './maintenance-admission-shadow.ts';
import { schedulePostTurnMaintenance } from './maintenance-admission-enforcer.ts';
import { ArcProjectionStore, ARC_PROJECTION_DB_FILE } from './arc-projection-store.ts';
import { AgentControlStore } from './agent-control-store.ts';
import { parseAgentLaneRuntimeConfig } from './agent-lane-runtime-config.ts';
import {
  evaluateAgentLaneRollout,
  type AgentRolloutLane,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import {
  ObservedChatCompletionClient,
  configuredModelUsageCostEstimator,
} from './model-usage-client.ts';
import { releaseDrainState } from './release-drain.ts';

function parsePort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('JG_WEB_PORT 必须是 1..65535 的整数');
  }
  return port;
}

const PORT = parsePort(process.env.JG_WEB_PORT, 17800);
const HOST = '127.0.0.1';
const APP_VERSION = '0.1.0';
const SERVER_INSTANCE_ID = randomUUID();
const WEB_DIST_DIR = resolve(process.env.JG_WEB_DIST ?? 'apps/web/dist');
/**
 * Vite dev origin 只在显式配置 `JG_DEV_WEB_PORT` 时才被信任。生产默认只允许后端自身
 * 的 loopback origin；此前无条件信任 `:5173` 等于任何本机进程都能借 dev server 来源读 API。
 */
const DEV_WEB_PORT = parseDevWebPort(process.env.JG_DEV_WEB_PORT);
const PUBLIC_HTTPS = parsePublicHttpsOrigins(process.env.JG_PUBLIC_HTTPS_ORIGINS);
const ACCESS_MODE = parseAccessMode(process.env.JG_ACCESS_MODE);
const configuredAppOrigins = process.env.JG_APP_ORIGINS?.trim();
const APP_ORIGINS = parseAppOrigins(
  ACCESS_MODE === 'secured' && PUBLIC_HTTPS.origins.size > 0
    ? [CAPACITOR_APP_ORIGIN, configuredAppOrigins].filter(Boolean).join(',')
    : configuredAppOrigins,
);
const SAME_ORIGIN_WEB = createExactOriginAllowlist([
  ...buildLocalExactOrigins(PORT, DEV_WEB_PORT),
  ...PUBLIC_HTTPS.origins,
]);
assertAppOriginsDisjoint(APP_ORIGINS, SAME_ORIGIN_WEB);
const ALLOWED_ORIGINS = createExactOriginAllowlist([
  ...SAME_ORIGIN_WEB,
  ...APP_ORIGINS,
]);
const LOCAL_AUTHORITIES = buildLocalExactAuthorities(PORT);
const ALLOWED_AUTHORITIES = new Set([
  ...LOCAL_AUTHORITIES,
  ...PUBLIC_HTTPS.authorities,
]);
const AGENT_CONTROL_MUTATION_RUNTIME = parseAgentControlMutationRuntimeConfig(process.env);
const MAINTENANCE_APPLY_RUNTIME = parseMaintenanceApplyRuntimeConfig(process.env);
const WORLDBOOK_REPAIR_RUNTIME = parseWorldbookRepairRuntimeConfig(process.env);
/**
 * Web 进程直接跑本地 bge：onnxruntime 原生推理占用唯一 HTTP 事件循环的风险**已知并接受**。
 * 缓解手段在 packages/memory/src/embedding.ts（推理 FIFO 串行 + sequential 执行 + 单线程）；
 * 若要彻底隔离，应把 embedding 移入 worker_threads，而不是重新加环境变量开关。
 */
/**
 * 数据目录：默认 cwd 下 data/；`JG_USER_DATA_DIR` 可覆盖。
 * 与 packages/core/src/asset-paths.ts 的约定保持一致（同一变量 = 同一隔离语义），
 * 避免「资产走了隔离目录、会话库仍写真实 data/」这类半隔离（测试曾因此在真实目录留下会话库）。
 */
const DATA_DIR = process.env.JG_USER_DATA_DIR
  ? resolve(process.env.JG_USER_DATA_DIR)
  : resolve('data');
const INTERACTIVE_RUNTIME = parseInteractiveRuntimeConfig();
const AGENT_ADMISSION_RUNTIME = parseAgentAdmissionRuntimeConfig();
const CONTEXT_COMPILER_RUNTIME = parseContextCompilerRuntimeConfig();
const LEARNING_TEXT_RUNTIME = parseLearningTextRuntimeConfig();
const MAINTENANCE_ADMISSION_RUNTIME = parseMaintenanceAdmissionRuntimeConfig();
const AGENT_RUNTIME_PROFILE = process.env.JG_AGENT_RUNTIME_PROFILE?.trim();
if (AGENT_RUNTIME_PROFILE !== undefined
  && !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(AGENT_RUNTIME_PROFILE)) {
  throw new Error('JG_AGENT_RUNTIME_PROFILE 非法');
}
const LEARNED_STYLE_PROPOSALS = new LearnedStyleProposalStore(
  resolve(DATA_DIR, 'style-proposals'),
  resolve(DATA_DIR, 'skills'),
);
const learnedStyleResolverForSession = (rawSessionId: string): NonNullable<
  import('../../tools/cli/session.ts').SessionArgs['learnedStyleResolver']
> => {
  const expectedSessionId = opaqueLearningToken('session', rawSessionId);
  return (scope) => scope.sessionId === expectedSessionId
    ? LEARNED_STYLE_PROPOSALS.resolveActive(scope) : null;
};
const releaseAdmissionOpen = (): boolean => !releaseDrainState(DATA_DIR).active;

// P8-09：restore workspace 位于 dataDir 同父级，必须在取得 dataDir 内部锁之前收敛崩溃切换。
recoverSnapshotRestoreBeforeServerLock({ dataDir: DATA_DIR });
if (readSnapshotRestorePendingMarker(DATA_DIR)) {
  throw new Error('快照恢复已切换，但认证世代尚未由 P8-10 轮换；服务保持 fail closed');
}

/**
 * P5.2-A2：访问模式。`local-only`（默认）保持现状零认证；`secured` 启用设备认证，
 * 要求先完成 `pnpm auth:bootstrap`——没有激活世代时 AuthRuntime.open() 抛错，
 * server **拒绝启动**而不是退回未认证模式（架构裁决：不许"配了 secured 却静默裸奔"）。
 */
if (PUBLIC_HTTPS.origins.size > 0 && ACCESS_MODE !== 'secured') {
  throw new Error('JG_PUBLIC_HTTPS_ORIGINS 只能与 JG_ACCESS_MODE=secured 同时启用');
}
if (APP_ORIGINS.size > 0
  && (ACCESS_MODE !== 'secured' || PUBLIC_HTTPS.origins.size === 0)) {
  throw new Error('JG_APP_ORIGINS 只能在 secured + private HTTPS 入口下启用');
}
const SERVER_PROCESS_LOCK = acquireServerProcessLock({
  dataDir: DATA_DIR,
  instanceId: SERVER_INSTANCE_ID,
});
// H7: authoritative deletion fences live beside DATA_DIR so a snapshot restore cannot roll them back.
// Opening this store is fail-closed: a corrupt privacy journal must prevent the server from serving
// restored session bytes without their tombstones.
const SESSION_DELETION_JOURNAL = new SessionDeletionJournal({ dataDir: DATA_DIR });
const INTERACTIVE_CALL_LEDGER = INTERACTIVE_RUNTIME.enabled
  ? new InteractiveCallLedger({ dataDir: DATA_DIR })
  : null;
const MODEL_USAGE_LEDGER = new ModelUsageLedger({ dataDir: DATA_DIR });
const AGENT_CONTROL_STORE = new AgentControlStore({ dataDir: DATA_DIR });
// Existing control state is reopened even after the forward gate is disabled so
// trusted operators retain reject/revert recovery access.
const WORLDBOOK_REPAIR_CONTROL = WORLDBOOK_REPAIR_RUNTIME.enabled
  || existsSync(resolve(DATA_DIR, WORLDBOOK_REPAIR_DB_FILE))
  ? new WorldbookRepairControl({ dataDir: DATA_DIR })
  : null;
const AGENT_ADMISSION_LEDGER = AGENT_ADMISSION_RUNTIME.enabled
  || CONTEXT_COMPILER_RUNTIME.enabled
  || MAINTENANCE_ADMISSION_RUNTIME.enabled
  || existsSync(resolve(DATA_DIR, AGENT_ADMISSION_DB_FILE))
  ? new AgentAdmissionLedger({ dataDir: DATA_DIR })
  : null;
// The projection remains unopened when Q8 is entirely absent, but an existing database
// is always reopened so snapshot, deletion and recovery lifecycle cannot silently omit it.
const ARC_PROJECTIONS = MAINTENANCE_ADMISSION_RUNTIME.enabled
  || existsSync(resolve(DATA_DIR, ARC_PROJECTION_DB_FILE))
  ? new ArcProjectionStore({ dataDir: DATA_DIR })
  : null;
let AGENT_LEARNING_LEDGER: AgentLearningLedger | null = null;
try {
  AGENT_LEARNING_LEDGER = new AgentLearningLedger({
    dataDir: DATA_DIR,
    // Only the durable fence is a terminal discard. The process-local pre-CAS reservation may be
    // released on revision conflict and therefore must never acknowledge/drop an outbox event.
    isSessionDeleted: (sessionId) => SESSION_DELETION_JOURNAL.isBlocked(sessionId),
  });
} catch {
  // 可重建学习库不能成为 server 启动门；session outbox 保留，等待下次修复/重启重投。
  console.warn('[AgentLearning] LEDGER_OPEN_FAILED（session outbox 保留，前台链继续）');
}
const LEARNING_OUTBOX_DRAINER = AGENT_LEARNING_LEDGER
  ? new LearningOutboxDrainer({ ledger: AGENT_LEARNING_LEDGER })
  : null;
const MODEL_USAGE_COST = configuredModelUsageCostEstimator();
const rolloutLane = (lane: 'interactive' | 'maintenance' | 'learning' | 'critic'): AgentRolloutLane => (
  rolloutLaneForAdmission(lane)
);
const maintenanceLaneExecutionAllowed = (sessionId: string): boolean => {
  // The legacy test-session allowlist and the durable lane control are both
  // required. The same exact-session predicate is used at enqueue and claim.
  if (!maintenanceAdmissionAllowsSession(MAINTENANCE_ADMISSION_RUNTIME, sessionId)) return false;
  let runtime;
  try { runtime = parseAgentLaneRuntimeConfig(process.env); }
  catch { return false; }
  try {
    if (!runtime.managed) {
      // Preserve the pre-Q9 launcher behavior just like agentTicketControl:
      // legacy `off` is not an activation decision, but kill/safety evidence is final.
      const current = AGENT_CONTROL_STORE.get('maintenance');
      if (current.desiredState === 'killed') return false;
      const safety = evaluateAgentLaneRollout({
        lane: 'maintenance',
        sessionId,
        desiredState: 'on',
        hostCeiling: 'on',
        evidence: AGENT_CONTROL_STORE.evidence('maintenance'),
      });
      if (safety.shouldKill) {
        AGENT_CONTROL_STORE.kill('maintenance', safety.reasonCodes[0]!);
        return false;
      }
      return true;
    }
    return AGENT_CONTROL_STORE.decide(
      'maintenance',
      sessionId,
      runtime.ceilings.maintenance,
    ).allowed;
  } catch {
    return false;
  }
};
const agentTicketControl = (
  input: import('../../packages/agent-policy/src/admission.ts').AdmissionRequest,
): ReturnType<AgentControlStore['get']> | false => {
  if (!agentCapabilityTicketAllowed(AGENT_CONTROL_STORE, input)) return false;
  const lane = rolloutLane(input.lane);
  const current = AGENT_CONTROL_STORE.get(lane);
  let runtime;
  try { runtime = parseAgentLaneRuntimeConfig(process.env); } catch { return false; }
  if (!runtime.managed) {
    // Unmanaged mode intentionally keeps legacy `off` execution compatibility, but never bypasses
    // a kill or cumulative safety evidence.
    if (current.desiredState === 'killed') return false;
    const safety = evaluateAgentLaneRollout({
      lane,
      sessionId: input.sessionId,
      desiredState: 'on',
      hostCeiling: 'on',
      evidence: AGENT_CONTROL_STORE.evidence(lane),
    });
    if (safety.shouldKill) {
      AGENT_CONTROL_STORE.kill(lane, safety.reasonCodes[0]!);
      return false;
    }
  } else if (!AGENT_CONTROL_STORE.decide(
    lane, input.sessionId, runtime.ceilings[lane],
  ).allowed) {
    return false;
  }
  return AGENT_CONTROL_STORE.get(lane);
};
const agentTicketAllowed = (
  input: import('../../packages/agent-policy/src/admission.ts').AdmissionRequest,
): boolean | Readonly<{
  allowed: true;
  maxModelCalls: number;
  quotaReservationDigest: string;
  reservationCreated: boolean;
}> => {
  const control = agentTicketControl(input);
  if (control === false) return false;
  const lane = rolloutLane(input.lane);
  try {
    const reservation = AGENT_CONTROL_STORE.reserveProviderCalls({
      lane,
      expectedControlRevision: control.revision,
      idempotencyKey: input.idempotencyKey,
      requestDigest: admissionRequestDigest(input),
      maxProviderCalls: input.limits.maxModelCalls,
      deadlineMs: input.deadlineMs,
    });
    return Object.freeze({
      allowed: true,
      maxModelCalls: reservation.maxModelCalls,
      quotaReservationDigest: reservation.reservationDigest,
      reservationCreated: reservation.created,
    });
  } catch {
    return false;
  }
};
const agentTicketBeginAllowed = (
  ticket: import('../../packages/agent-policy/src/admission.ts').AdmissionTicket,
): boolean => {
  if (!agentCapabilityTicketAllowed(AGENT_CONTROL_STORE, ticket)) return false;
  const lane = rolloutLane(ticket.lane);
  const current = AGENT_CONTROL_STORE.get(lane);
  if (current.desiredState === 'killed') return false;
  let runtime;
  try { runtime = parseAgentLaneRuntimeConfig(process.env); } catch { return false; }
  const decision = evaluateAgentTicketBeginPolicy({
    lane: ticket.lane,
    sessionId: ticket.sessionId,
    desiredState: current.desiredState,
    hostCeiling: runtime.ceilings[lane],
    managed: runtime.managed,
    reservedModelCalls: ticket.quotaReservationDigest ? ticket.limits.maxModelCalls : 0,
    evidence: AGENT_CONTROL_STORE.evidence(lane),
  });
  if (decision.shouldKill) {
    AGENT_CONTROL_STORE.kill(lane, decision.reasonCodes[0]!);
    return false;
  }
  return runtime.managed ? decision.allowed : true;
};
const AGENT_ADMISSION_BROKER = new AdmissionTicketBroker({
  authorizeIssue: agentTicketAllowed,
  authorizeBegin: agentTicketBeginAllowed,
  markReservationStarted: (digest) => AGENT_CONTROL_STORE.markProviderCallReservationStarted(digest),
  releaseReservation: (digest) => AGENT_CONTROL_STORE.releaseProviderCallReservation(digest),
});
const CONTEXT_CAPSULE_CACHE = new ContextCapsuleCache(32);
type AgentControlObservation = Parameters<AgentControlStore['recordObservation']>[0];
const recordAgentControlObservation = (input: AgentControlObservation): void => {
  AGENT_CONTROL_STORE.recordObservation(input);
  let runtime;
  try { runtime = parseAgentLaneRuntimeConfig(process.env); } catch {
    AGENT_CONTROL_STORE.kill(input.lane, 'host-config-invalid');
    return;
  }
  const ceiling = runtime.managed ? runtime.ceilings[input.lane] : 'on';
  AGENT_CONTROL_STORE.decide(input.lane, input.sessionId, ceiling);
};
const recordAgentRuntimeLease = (entry: AdmittedModelLeaseAudit): void => {
  const lane = rolloutLane(entry.lane);
  try {
    AGENT_ADMISSION_LEDGER?.recordRuntimeLease(entry);
  } catch (error) {
    try {
      recordAgentControlObservation({
        lane,
        sessionId: entry.sessionId,
        parentRunId: entry.parentRunId,
        sensitiveAuditViolations: 1,
      });
    } catch { /* Preserve the original required-audit failure. */ }
    throw error;
  }
  recordAgentControlObservation({
    lane,
    sessionId: entry.sessionId,
    parentRunId: entry.parentRunId,
    ...(entry.quotaReservationDigest
      ? { reservationDigest: entry.quotaReservationDigest }
      : {}),
    qualifyingSample: entry.outcome === 'completed' && entry.authorizationCallsUsed > 0,
    providerCalls: entry.authorizationCallsUsed,
    providerErrors: entry.providerErrorAttemptsUsed,
    ...(entry.authorizationCallsUsed > 0 ? { latencyMs: entry.wallMsUsed } : {}),
  });
};
let modelUsageRecordWarningEmitted = false;
process.once('exit', () => {
  try { MODEL_USAGE_LEDGER.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_ADMISSION_LEDGER?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_LEARNING_LEDGER?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { ARC_PROJECTIONS?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { WORLDBOOK_REPAIR_CONTROL?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_CONTROL_STORE.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SESSION_DELETION_JOURNAL.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SERVER_PROCESS_LOCK.release(); } catch { /* exit 阶段只做固定锁目录的 best-effort 清理。 */ }
});
const ASSET_UPLOAD_TEMP_DIR = resolve(DATA_DIR, '.upload-tmp');
pruneAssetUploadTemps(ASSET_UPLOAD_TEMP_DIR);
const ASSET_IDENTITIES = new AssetIdentityRegistry(resolve(DATA_DIR, 'asset-identities.v1.json'));
const ASSET_IMPORT_TRANSACTIONS = new AssetImportTransactionCoordinator({
  dataDir: DATA_DIR,
  identities: ASSET_IDENTITIES,
});
// P8-04: process lock is already held; recovery completes before any HTTP listener exists.
ASSET_IMPORT_TRANSACTIONS.recover();
const SNAPSHOT_FREEZE = new SynchronousSnapshotFreezeAdapter({
  dataDir: DATA_DIR,
  serverLock: SERVER_PROCESS_LOCK,
});
const SNAPSHOT_COORDINATOR = new SnapshotCoordinator({
  dataDir: DATA_DIR,
  serverLock: SERVER_PROCESS_LOCK,
  freeze: SNAPSHOT_FREEZE,
  sqlite: new SqliteOnlineSnapshotAdapter(),
});
// P8-08：必须在 AuthRuntime.open() 和 listener 之前恢复 capture lock/intent/maintenance lease。
SNAPSHOT_COORDINATOR.recover();
if (ACCESS_MODE === 'secured') {
  // 依赖链仍含大量面向本机 CLI 的 console 诊断，其中可能拼接聊天正文、Provider
  // 异常或绝对路径。远程模式统一截断为固定事件；可关联细节只进入白名单安全审计。
  console.log = () => {};
  console.warn = () => { process.stderr.write('[web-api] secured warning detail=redacted\n'); };
  console.error = () => { process.stderr.write('[web-api] secured error detail=redacted\n'); };
}
const AUTH_RUNTIME = ACCESS_MODE === 'secured' ? AuthRuntime.open({ dataDir: DATA_DIR }) : null;
const INSTALLATION_IDENTITY = loadOrCreateInstallationIdentity({ dataDir: DATA_DIR });
const AUTH_STREAMS = new AuthenticatedStreamRegistry();
/**
 * 配对端点的 pre-body 限流（A2-02：在解析 code 之前执行）：
 * 每个远端地址 10 次/分钟、全局 60 次/分钟、窗口 1 分钟。
 * 进程内存态即可——配对码另有 attempts（持久）与 TTL 两层防线。
 */
const AUTH_PAIR_ADMISSION = new PairingAdmissionController({
  perKeyLimit: 10,
  globalLimit: 60,
  windowMs: 60_000,
  maxConcurrent: 4,
});
const AUTH_REQUEST_ADMISSION = new RequestAdmissionController();
const PLUGINS_DIR = resolve(DATA_DIR, 'plugins');
/** 前端日志落盘路径（日志模块 v0.1.0：浏览器批量上报 → 逐行追加） */
const WEB_LOG_PATH = resolve(DATA_DIR, 'web.log');
const SECURITY_AUDIT_PATH = resolve(DATA_DIR, 'security', 'audit.ndjson');
const SECURITY_AUDIT = AUTH_RUNTIME
  ? new SecurityAuditWriter((line) => appendFileSync(SECURITY_AUDIT_PATH, line, 'utf8'))
  : null;
/** GLA 远端资源缓存目录（全局共享：默认 %TEMP%/jiuguan-assets，与启动目录无关；env JG_ASSETS_DIR 可覆盖） */
const ASSET_DIR = DEFAULT_ASSETS_DIR;

function apiErrorCodeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 428) return 'precondition_required';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  return 'bad_request';
}

function apiErrorMessage(code: ApiErrorCode): string {
  switch (code) {
    case 'unauthorized': return '需要重新认证';
    case 'forbidden': return '当前设备没有执行此操作的权限';
    case 'not_found': return '请求的资源不存在';
    case 'conflict': return '资源状态已变化，请刷新后重试';
    case 'precondition_required': return '缺少资源版本前置条件，请刷新后重试';
    case 'rate_limited': return '请求过于频繁，请稍后再试';
    case 'incompatible_client': return '客户端版本不兼容';
    case 'internal_error': return '服务器内部错误';
    default: return '请求参数不正确';
  }
}

function safeLegacyReason(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
    ? value
    : undefined;
}

/** secured 模式唯一公开错误投影：丢弃原始 message/path/body，只保留稳定枚举和安全 reasonCode。 */
function remoteErrorPayload(
  res: ServerResponse,
  source: unknown,
  status: number,
): ApiErrorPayload {
  const row = source && typeof source === 'object' ? source as Record<string, unknown> : {};
  const nested = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : {};
  const code = apiErrorCodeForStatus(status);
  const reasonCode = safeLegacyReason(row.code) ?? safeLegacyReason(nested.code);
  const headerRequestId = res.getHeader(REQUEST_ID_HEADER);
  const requestId = typeof headerRequestId === 'string' && isSafeOpaqueId(headerRequestId)
    ? headerRequestId
    : undefined;
  const unsafeDetails = nested.details && typeof nested.details === 'object' && !Array.isArray(nested.details)
    ? nested.details as Record<string, unknown>
    : undefined;
  const actualRevision = unsafeDetails?.actualRevision;
  const expectedRevision = unsafeDetails?.expectedRevision;
  const resourceId = unsafeDetails?.resourceId;
  const revisionDetails = status === 409
    && isEntityRevision(actualRevision, true)
    && (expectedRevision === undefined || isEntityRevision(expectedRevision, true))
    && (resourceId === undefined || (typeof resourceId === 'string' && resourceId.length <= 240 && !/[\u0000-\u001f\u007f]/.test(resourceId)))
    ? {
        actualRevision,
        ...(typeof expectedRevision === 'string' ? { expectedRevision } : {}),
        ...(typeof resourceId === 'string' ? { resourceId } : {}),
      }
    : undefined;
  const details = {
    ...(reasonCode && reasonCode !== code ? { reasonCode } : {}),
    ...(revisionDetails ?? {}),
  };
  return {
    error: {
      code,
      message: apiErrorMessage(code),
      ...(requestId ? { requestId } : {}),
      ...(status === 408 || status === 429 || status >= 500 ? { retryable: true } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
  };
}

/** 后端兜底脱敏：剥掉 data 里的敏感字段（apiKey/key/token/authorization…），避免 key 落盘 */
function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api_?key|key|token|authorization|auth|secret|password)$/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = stripSensitive(v);
      }
    }
    return out;
  }
  return value;
}

const sessions = new Map<string, ChatSession>();
const learningDrainScheduled = new WeakSet<ChatSession>();
const learningReconcileRequested = new WeakSet<ChatSession>();
const learningReconcileCursor = new WeakMap<ChatSession, { createdAt: string; eventId: string }>();
let learningDrainWarningEmitted = false;

function hydrateLearningFromLedger(session: ChatSession): void {
  if (!AGENT_LEARNING_LEDGER) return;
  session.hydrateLearningProfiles(AGENT_LEARNING_LEDGER.learningHydration(session.learningProfileIdentity()));
}

/** Resume must finish source reconciliation before the central projection becomes visible to the session. */
function reconcileAndHydrateLearning(session: ChatSession): void {
  if (!LEARNING_OUTBOX_DRAINER) return;
  let after: { createdAt: string; eventId: string } | undefined;
  for (;;) {
    const result = LEARNING_OUTBOX_DRAINER.reconcileAvailable(session, {
      limit: 256,
      ...(after ? { after } : {}),
    });
    if (result.scanned < 256 || !result.nextCursor) break;
    after = result.nextCursor;
  }
  hydrateLearningFromLedger(session);
}

/** 成功响应之后的本地异步搬运；目标库故障只留 pending，不回写正文/任务终态。 */
function scheduleLearningDrain(session: ChatSession, reconcile = false): void {
  if (!LEARNING_OUTBOX_DRAINER) return;
  if (reconcile) learningReconcileRequested.add(session);
  if (learningDrainScheduled.has(session)) return;
  learningDrainScheduled.add(session);
  const timer = setTimeout(() => {
    learningDrainScheduled.delete(session);
    try {
      const rebuilding = learningReconcileRequested.has(session);
      const result = rebuilding
        ? LEARNING_OUTBOX_DRAINER.reconcileAvailable(session, {
            limit: 256,
            ...(learningReconcileCursor.has(session) ? { after: learningReconcileCursor.get(session)! } : {}),
          })
        : LEARNING_OUTBOX_DRAINER.drainAvailable(session, 256);
      if (rebuilding && result.scanned === 256 && result.nextCursor) {
        learningReconcileCursor.set(session, result.nextCursor);
        scheduleLearningDrain(session, true);
      } else {
        learningReconcileRequested.delete(session);
        learningReconcileCursor.delete(session);
        if (!rebuilding && result.scanned === 256) scheduleLearningDrain(session);
        else hydrateLearningFromLedger(session);
      }
    } catch {
      if (!learningDrainWarningEmitted) {
        learningDrainWarningEmitted = true;
        console.warn('[AgentLearning] OUTBOX_DRAIN_FAILED（pending 保留，前台链继续）');
      }
    }
  }, 0);
  timer.unref();
}
/**
 * P4 回滚开关：默认所有 Web 会话走进程内 ProviderRegistry；设为 0 时仅回到
 * 旧 OpenAI-compatible 直连链路。它不改变 loopback 监听，也不会开启任何手机入口。
 */
const PROVIDER_SPI_ENABLED = process.env.JG_PROVIDER_SPI !== '0';
const PROVIDER_OWNER_ID = 'core.server';
const COMMANDCODE_PROVIDER_ID = 'commandcode';
const COMMANDCODE_PROVIDER_PLUGIN_ID = 'commandcode-provider';
const providerRegistry = new ProviderRegistry({
  onDisposeError: (providerId) => {
    // 插件异常可能夹带上游响应或凭据；生命周期日志只记录稳定事件。
    console.warn(`[Provider] ${providerId} 清理异常 (PROVIDER_DISPOSE_FAILED)`);
  },
  onLateInvocationError: (providerId, error) => {
    console.warn(`[Provider] ${providerId} 迟到调用已隔离: ${error.code}`);
  },
});
const openAIProvider = createOpenAIProviderController(loadProviderConfig());
if (PROVIDER_SPI_ENABLED) {
  providerRegistry.registerBuiltin(PROVIDER_OWNER_ID, openAIProvider.adapter);
}
const registryProviderClient = createRegistryProviderClient({
  registry: providerRegistry,
  resolveSelection: () => {
    const cfg = loadProviderConfig();
    return { providerId: cfg.providerId, model: cfg.model };
  },
});

/** 重新读取电脑端配置并更新 builtin descriptor；Key 只留在 controller 内。 */
function refreshProviderConfiguration(): ReturnType<typeof loadProviderConfig> {
  const cfg = loadProviderConfig();
  const descriptor = openAIProvider.rebind(cfg);
  if (PROVIDER_SPI_ENABLED) providerRegistry.updateDescriptor(PROVIDER_OWNER_ID, descriptor);
  for (const session of sessions.values()) {
    try { session.rebindProvider(cfg); } catch { /* 单个会话刷新失败不阻塞配置提交 */ }
  }
  return cfg;
}

function providerClientForServer() {
  return PROVIDER_SPI_ENABLED ? registryProviderClient : undefined;
}

/** Resolve one exact provider/model profile at a ticket boundary; callers keep that immutable
 * value for budget derivation and ticket issuance instead of observing a mid-call UI switch. */
function modelRuntimeProfileFor(
  cfg: ReturnType<typeof loadProviderConfig>,
  client: ChatCompletionClient = registryProviderClient,
) {
  let capabilities: { readonly stream: boolean; readonly tools: boolean } | undefined;
  try { capabilities = client.capabilities?.(); } catch { /* unresolved means conservative false */ }
  return resolveModelRuntimeProfile({
    providerId: cfg.providerId,
    modelId: cfg.model,
    supportsTools: capabilities?.tools === true,
    supportsStreaming: capabilities?.stream === true,
  });
}

/** 包装任意生产客户端；只旁路写脱敏用量，绝不改变 Provider 请求或业务响应。 */
function observeServerModelClient(client: ChatCompletionClient): ChatCompletionClient {
  return new ObservedChatCompletionClient(client, {
    record: (entry) => { MODEL_USAGE_LEDGER.record(entry); },
    resolveProviderId: () => loadProviderConfig().providerId,
    estimateCost: MODEL_USAGE_COST,
    onRecordError: () => {
      if (modelUsageRecordWarningEmitted) return;
      modelUsageRecordWarningEmitted = true;
      console.warn('[ModelUsage] MODEL_USAGE_RECORD_FAILED（正文链继续运行）');
    },
  });
}

function interactiveHarnessForSession(
  rawSessionId: string,
): import('../../tools/cli/session.ts').SessionArgs['interactiveHarness'] {
  if (!INTERACTIVE_RUNTIME.enabled || INTERACTIVE_RUNTIME.lane === 'off' || !INTERACTIVE_CALL_LEDGER) return undefined;
  const cfg = loadProviderConfig();
  const budgetProfile = interactiveBudgetProfileForAutonomy(
    INTERACTIVE_RUNTIME.budgetProfile!.autonomyProfile,
    process.env,
    modelRuntimeProfileFor(cfg),
  );
  return {
    lane: INTERACTIVE_RUNTIME.lane,
    budgetProfile,
    inputMicrousdPerMillionTokens: INTERACTIVE_RUNTIME.inputMicrousdPerMillionTokens!,
    outputMicrousdPerMillionTokens: INTERACTIVE_RUNTIME.outputMicrousdPerMillionTokens!,
    variableSpecs: INTERACTIVE_RUNTIME.variableSpecs,
    audit: (entry) => { INTERACTIVE_CALL_LEDGER.record(entry, { sessionId: rawSessionId }); },
  };
}

function agentAdmissionForSession(rawSessionId: string): import('../../tools/cli/session.ts').SessionArgs['agentAdmission'] {
  if ((!AGENT_ADMISSION_RUNTIME.enabled && !CONTEXT_COMPILER_RUNTIME.enabled)
    || !AGENT_ADMISSION_LEDGER) return undefined;
  const runPreferenceLearningCall = async (input: {
    client: ChatCompletionClient;
    rawSessionId: string;
    ticketSessionId: string;
    runId: string;
    sourceRevision: string;
    contentMode: 'nsf' | 'nsfw';
    signal?: AbortSignal;
  }, request: {
    policyVersion: string;
    reasonCode: string;
    cooldownKey: string;
    idempotencyKey: string;
    evidence: unknown;
    modelRequest: import('../../packages/proxy/src/client.ts').ChatRequest;
    maxOutputTokens: number;
  }): Promise<string | null> => {
    let liveAdmission;
    let livePrivacy;
    try {
      liveAdmission = parseAgentAdmissionRuntimeConfig(process.env);
      livePrivacy = parseLearningTextRuntimeConfig(process.env);
    } catch {
      return null;
    }
    if (!livePrivacy.preferenceEnabled
      || !agentAdmissionAllowsSession(liveAdmission, input.rawSessionId)
      || input.runId === 'missing-run' || !MODEL_USAGE_COST) return null;
    const provider = loadProviderConfig();
    const budgetProfile = agentTaskBudgetProfile(
      'preference_extract',
      process.env,
      { maxOutputTokens: request.maxOutputTokens },
      modelRuntimeProfileFor(provider, input.client),
    );
    const tools: Record<string, unknown>[] = [];
    const evidenceDigest = sha256Digest(JSON.stringify(request.evidence));
    const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, input.client, {
      estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
      onLeaseClosed: recordAgentRuntimeLease,
      auditRequired: true,
    });
    const ticket = AGENT_ADMISSION_BROKER.issue({
      runId: input.runId,
      parentRunId: input.runId,
      sessionId: input.ticketSessionId,
      sourceRevision: input.sourceRevision,
      lane: 'learning',
      taskKind: 'preference_extract',
      policyVersion: request.policyVersion,
      modelId: provider.model,
      budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
      toolSetDigest: agentToolSetDigest(tools),
      mode: input.contentMode,
      reasonCodes: [request.reasonCode],
      evidenceDigests: [evidenceDigest],
      noveltyDigest: evidenceDigest,
      expectedBenefit: request.policyVersion.includes('branch')
        ? 'branch-relevance' : 'preference-learning',
      limits: admissionLimitsFromBudgetProfile(budgetProfile),
      deadlineMs: Date.now() + budgetProfile.maxWallMs,
      allowedTools: [],
      fullSkillSnapshots: [],
      cooldownKey: request.cooldownKey,
      idempotencyKey: request.idempotencyKey,
      fallback: 'skip-optional-agent',
    });
    const lease = gateway.open({
      binding: {
        ticketId: ticket.ticketId,
        runId: ticket.runId,
        parentRunId: ticket.parentRunId,
        sessionId: ticket.sessionId,
        sourceRevision: ticket.sourceRevision,
        lane: ticket.lane,
        taskKind: ticket.taskKind,
        policyVersion: ticket.policyVersion,
        mode: ticket.mode,
        budgetProfile,
      },
      modelId: provider.model,
      tools,
    });
    const response = await lease.complete({
      model: provider.model,
      ...request.modelRequest,
      max_tokens: budgetProfile.agentOutputBudgetTokens,
    }, input.signal);
    return response.content;
  };
  return {
    // The server-side usage observer persists Provider usage whenever the selected Provider returns it.
    providerReportsUsage: true,
    observeRuntime: (input) => {
      recordAgentControlObservation({
        lane: 'interactive',
        sessionId: input.ticketSessionId,
        parentRunId: input.parentRunId,
        invalidCalls: input.invalidCalls,
        playerSovereigntyViolations: input.playerSovereigntyViolations,
        unauthorizedOrStaleWrites: input.unauthorizedOrStaleWrites,
        duplicateWrites: input.duplicateWrites,
        sensitiveAuditViolations: input.sensitiveAuditViolations,
      });
    },
    readStructuredFacts: (input) => {
      if (!AGENT_LEARNING_LEDGER) return { arcEvidence: 'unknown', dormantArcReferenceCount: 0 };
      const projection = selectArcSessionProjection(
        AGENT_LEARNING_LEDGER.arcSessionProjections(),
        input,
      );
      const npcProjection = selectNpcSessionProjection(
        AGENT_LEARNING_LEDGER.npcSessionProjections(),
        input,
      );
      const approved = ARC_PROJECTIONS?.read(rawSessionId);
      const effectiveArcStatus = (arc: NonNullable<typeof projection>['arcs'][number]) => (
        approved?.statuses[arc.arcId] ?? arc.status
      );
      const activeArcCount = projection?.arcs.filter((arc) => (
        effectiveArcStatus(arc) === 'open' && approved?.mergedInto[arc.arcId] === undefined
      )).length ?? 0;
      const learnedDependencyReviews = projection?.proposals.filter(
        (proposal) => proposal.kind === 'dependency_review',
      ).length ?? 0;
      const resolvedDependencyReviews = Object.keys(approved?.dependencies ?? {}).length;
      const unresolvedDependencyCount = Math.max(0, learnedDependencyReviews - resolvedDependencyReviews);
      const goalActors = npcProjection?.characters.filter(
        (character) => (character.evidenceCounts.goal ?? 0) > 0,
      ).length ?? 0;
      // An open, readable projection ledger proves absence as zero. A reference signal is only
      // emitted when the deterministic QueryPlan already classified this as an old-story query.
      return {
        arcEvidence: 'known',
        dormantArcReferenceCount: input.referencedOldStory
          ? (projection?.arcs.filter((arc) => effectiveArcStatus(arc) === 'dormant').length ?? 0)
          : 0,
        activeArcCount,
        unresolvedDependencyCount,
        npcGoalConflictCount: Math.max(0, goalActors - 1),
      };
    },
    audit: (entry) => { AGENT_ADMISSION_LEDGER.record(entry); },
    auditDirectorCritic: (entry) => { AGENT_ADMISSION_LEDGER.recordDirectorCritic(entry); },
    ...(CONTEXT_COMPILER_RUNTIME.enabled && MODEL_USAGE_COST ? {
      compileContext: async (input) => {
        let live;
        const provider = loadProviderConfig();
        try {
          live = parseContextCompilerRuntimeConfig(
            process.env,
            modelRuntimeProfileFor(provider, input.client),
          );
        } catch { return null; }
        if (!contextCompilerAllowsSession(live, input.rawSessionId)
          || !live.budgetProfile || input.runId === 'missing-run') return null;
        try {
          const sourceDigest = contextCompilerSourceDigest(input.sources);
          const cached = CONTEXT_CAPSULE_CACHE.get(sourceDigest, input.targetTokens);
          if (cached) return cached;

          // One Provider call is the hard ceiling. Multi-batch inputs defer to the next
          // deterministic fallback rather than compiling an incomplete, misleading capsule.
          const batches = partitionContextCompilerSources(
            input.sources,
            Math.max(256, live.budgetProfile.agentInputBudgetTokens - 1_500),
          );
          if (batches.length !== 1) return null;
          const compiled = buildContextCompilerModelRequest({
            sources: batches[0]!,
            targetTokens: input.targetTokens,
            maxInputTokens: live.budgetProfile.agentInputBudgetTokens,
            maxOutputTokens: live.budgetProfile.agentOutputBudgetTokens,
          });
          const tools: Record<string, unknown>[] = [];
          const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, input.client, {
            estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
            onLeaseClosed: recordAgentRuntimeLease,
            auditRequired: true,
          });
          const ticket = AGENT_ADMISSION_BROKER.issue({
            runId: input.runId,
            parentRunId: input.runId,
            sessionId: input.ticketSessionId,
            sourceRevision: input.sourceRevision,
            lane: 'interactive',
            taskKind: 'context_compiler',
            policyVersion: CONTEXT_COMPILER_POLICY_VERSION,
            modelId: provider.model,
            budgetProfileDigest: agentBudgetProfileDigest(live.budgetProfile),
            toolSetDigest: agentToolSetDigest(tools),
            mode: input.contentMode,
            reasonCodes: ['elastic-context-recovery-required'],
            evidenceDigests: [compiled.expectation.sourceDigest],
            noveltyDigest: compiled.expectation.sourceDigest,
            expectedBenefit: 'context-recovery',
            limits: admissionLimitsFromBudgetProfile(live.budgetProfile),
            deadlineMs: Date.now() + live.budgetProfile.maxWallMs,
            allowedTools: [],
            fullSkillSnapshots: [],
            cooldownKey: `context-compiler:${input.ticketSessionId}`,
            idempotencyKey: `admit:${input.runId.slice(0, 120)}:context:${sourceDigest.slice(-16)}`,
            fallback: 'continue-deterministic',
          });
          const response = await gateway.complete({
            binding: {
              ticketId: ticket.ticketId,
              runId: ticket.runId,
              parentRunId: ticket.parentRunId,
              sessionId: ticket.sessionId,
              sourceRevision: ticket.sourceRevision,
              lane: ticket.lane,
              taskKind: ticket.taskKind,
              policyVersion: ticket.policyVersion,
              mode: ticket.mode,
              budgetProfile: live.budgetProfile,
            },
            request: { ...compiled.request, model: provider.model },
            signal: input.signal,
          });
          const capsule = parseContextCapsule(response.content ?? '', compiled.expectation);
          CONTEXT_CAPSULE_CACHE.set(capsule);
          return capsule;
        } catch {
          return null;
        }
      },
    } : {}),
    ...(AGENT_ADMISSION_RUNTIME.executionEnabled
      && MODEL_USAGE_COST
      ? {
          requestAqlReplan: async (input) => {
            let live;
            try { live = parseAgentAdmissionRuntimeConfig(process.env); } catch { return null; }
            if (!agentAdmissionAllowsSession(live, input.rawSessionId)
              || input.runId === 'missing-run' || !MODEL_USAGE_COST) return null;
            const provider = loadProviderConfig();
            const budgetProfile = agentTaskBudgetProfile(
              'aql_replan', process.env, {}, modelRuntimeProfileFor(provider, input.client),
            );
            const tools: Record<string, unknown>[] = [];
            const evidenceDigest = sha256Digest(input.prompt);
            const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, input.client, {
              estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
              onLeaseClosed: recordAgentRuntimeLease,
              auditRequired: true,
            });
            const ticket = AGENT_ADMISSION_BROKER.issue({
              runId: input.runId,
              parentRunId: input.runId,
              sessionId: input.ticketSessionId,
              sourceRevision: input.sourceRevision,
              lane: 'interactive',
              taskKind: 'aql_replan',
              policyVersion: 'p14-q9r-aql-replan-interactive-v1',
              modelId: provider.model,
              budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
              toolSetDigest: agentToolSetDigest(tools),
              mode: input.contentMode,
              reasonCodes: ['regenerate-replan-threshold'],
              evidenceDigests: [evidenceDigest],
              noveltyDigest: evidenceDigest,
              expectedBenefit: 'branch-relevance',
              limits: admissionLimitsFromBudgetProfile(budgetProfile),
              deadlineMs: Date.now() + budgetProfile.maxWallMs,
              allowedTools: [],
              fullSkillSnapshots: [],
              cooldownKey: `aql-replan:${input.ticketSessionId}`,
              idempotencyKey: `admit:${input.runId.slice(0, 120)}:aql-replan`,
              fallback: 'skip-optional-agent',
            });
            try {
              const response = await gateway.complete({
                binding: {
                  ticketId: ticket.ticketId,
                  runId: ticket.runId,
                  parentRunId: ticket.parentRunId,
                  sessionId: ticket.sessionId,
                  sourceRevision: ticket.sourceRevision,
                  lane: ticket.lane,
                  taskKind: ticket.taskKind,
                  policyVersion: ticket.policyVersion,
                  mode: ticket.mode,
                  budgetProfile,
                },
                request: {
                  model: provider.model,
                  messages: [
                    { role: 'system', content: '你是剧本导演。只输出不超过 200 字的重写方向，不解释、不调用工具、不改数据库。' },
                    { role: 'user', content: `=== 当前剧情上下文 ===\n${input.prompt}` },
                  ],
                  temperature: 0.6,
                  max_tokens: budgetProfile.agentOutputBudgetTokens,
                },
                signal: input.signal,
              });
              return response.content;
            } catch {
              return null;
            }
          },
          admitInteractivePrelude: (input) => {
            // Re-read only at a new turn boundary. Changing the global switch to off or
            // removing this session from the allowlist immediately returns to legacy.
            let live;
            try { live = parseAgentAdmissionRuntimeConfig(process.env); } catch { return null; }
            if (!agentAdmissionAllowsSession(live, input.rawSessionId)
              || (input.audit.decision.verdict !== 'would-admit'
                && input.director.verdict !== 'would-direct')
              || input.audit.runId !== input.runId
              || input.audit.sessionId !== input.ticketSessionId
              || input.audit.sourceRevision !== input.sourceRevision) return null;
            const provider = loadProviderConfig();
            const budgetProfile = agentTaskBudgetProfile(
              'interactive_prelude', process.env, {}, modelRuntimeProfileFor(provider, input.client),
            );
            const tools = [...INTERACTIVE_NATIVE_TOOLS];
            const allowedTools = tools.map((entry) => {
              const fn = (entry as { function?: { name?: unknown } }).function;
              if (typeof fn?.name !== 'string') throw new Error('interactive-tool-contract-invalid');
              return fn.name;
            });
            const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, input.client, {
              estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
              onLeaseClosed: recordAgentRuntimeLease,
              auditRequired: true,
            });
            const ticket = AGENT_ADMISSION_BROKER.issue({
              runId: input.runId,
              parentRunId: input.runId,
              sessionId: input.ticketSessionId,
              sourceRevision: input.sourceRevision,
              lane: 'interactive',
              taskKind: 'interactive_prelude',
              policyVersion: input.audit.decision.verdict === 'would-admit'
                ? input.audit.decision.policyVersion
                : input.director.policyVersion,
              modelId: provider.model,
              budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
              toolSetDigest: agentToolSetDigest(tools),
              mode: input.contentMode,
              reasonCodes: [...new Set([
                ...(input.audit.decision.verdict === 'would-admit'
                  ? input.audit.decision.reasonCodes
                  : []),
                ...(input.director.verdict === 'would-direct'
                  ? input.director.reasonCodes
                  : []),
              ])],
              evidenceDigests: [...new Set([
                input.audit.decision.factsDigest,
                input.audit.facts.routingDigest,
                input.director.factsDigest,
              ])],
              noveltyDigest: input.audit.decision.factsDigest,
              expectedBenefit: input.director.verdict === 'would-direct'
                ? 'branch-relevance'
                : input.audit.decision.hardSignals.includes('variable-write-intent')
                  ? 'state-correctness'
                  : 'fact-verification',
              limits: admissionLimitsFromBudgetProfile(budgetProfile),
              deadlineMs: Date.now() + budgetProfile.maxWallMs,
              allowedTools,
              fullSkillSnapshots: input.fullSkillSnapshots,
              cooldownKey: `interactive:${input.runId}`,
              idempotencyKey: `admit:${input.runId}:interactive`,
              fallback: 'continue-deterministic',
            });
            const binding = {
              ticketId: ticket.ticketId,
              runId: ticket.runId,
              parentRunId: ticket.parentRunId,
              sessionId: ticket.sessionId,
              sourceRevision: ticket.sourceRevision,
              lane: ticket.lane,
              taskKind: ticket.taskKind,
              policyVersion: ticket.policyVersion,
              mode: ticket.mode,
              budgetProfile,
            } as const;
            const lease = gateway.open({ binding, modelId: provider.model, tools });
            const client: ChatCompletionClient = {
              complete: (request, signal) => lease.complete({ ...request, model: provider.model }, signal),
              stream: (request, onDelta, onToolArg, signal) => lease.stream(
                { ...request, model: provider.model }, onDelta, onToolArg, signal,
              ),
              capabilities: () => ({ stream: true, tools: true }),
              modelName: () => provider.model,
            };
            return {
              client,
              budgetProfile,
              finish: (outcome) => lease.finish(
                outcome,
                outcome === 'provider_error' ? 'gateway-provider-call-failed'
                  : outcome === 'cancelled' ? 'gateway-provider-call-cancelled' : undefined,
              ),
            };
          },
          repairDraft: async (input) => {
            let live;
            try { live = parseAgentAdmissionRuntimeConfig(process.env); } catch { return null; }
            if (!agentAdmissionAllowsSession(live, input.rawSessionId)
              || input.decision.severity !== 'repairable'
              || input.decision.hardDenyCodes.length > 0
              || input.runId === 'missing-run') return null;
            const provider = loadProviderConfig();
            const budgetProfile = agentTaskBudgetProfile(
              'critic_revision', process.env, {}, modelRuntimeProfileFor(provider, input.client),
            );
            const tools: Record<string, unknown>[] = [];
            const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, input.client, {
              estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
              onLeaseClosed: recordAgentRuntimeLease,
              auditRequired: true,
            });
            const ticket = AGENT_ADMISSION_BROKER.issue({
              runId: input.runId,
              parentRunId: input.runId,
              sessionId: input.ticketSessionId,
              sourceRevision: input.sourceRevision,
              lane: 'critic',
              taskKind: 'critic_revision',
              policyVersion: input.decision.policyVersion,
              modelId: provider.model,
              budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
              toolSetDigest: agentToolSetDigest(tools),
              mode: input.contentMode,
              reasonCodes: input.decision.repairableCodes,
              evidenceDigests: [input.decision.factsDigest],
              noveltyDigest: input.decision.factsDigest,
              expectedBenefit: 'draft-correction',
              limits: admissionLimitsFromBudgetProfile(budgetProfile),
              deadlineMs: Date.now() + budgetProfile.maxWallMs,
              allowedTools: [],
              fullSkillSnapshots: input.fullSkills.map((skill) => skill.snapshot),
              cooldownKey: `critic:${input.runId}`,
              idempotencyKey: `admit:${input.runId}:critic`,
              fallback: 'use-original-draft',
            });
            const lease = gateway.open({
              binding: {
                ticketId: ticket.ticketId,
                runId: ticket.runId,
                parentRunId: ticket.parentRunId,
                sessionId: ticket.sessionId,
                sourceRevision: ticket.sourceRevision,
                lane: ticket.lane,
                taskKind: ticket.taskKind,
                policyVersion: ticket.policyVersion,
                mode: ticket.mode,
                budgetProfile,
              },
              modelId: provider.model,
              tools,
            });
            const response = await lease.complete({
              ...buildPrecommitCriticModelRequest({
                decision: input.decision,
                draft: input.draft,
                fullSkills: input.fullSkills,
                maxOutputTokens: budgetProfile.agentOutputBudgetTokens,
              }),
              model: provider.model,
            }, input.signal);
            return response.content;
          },
          summarizeRolling: async (input) => {
            let live;
            try { live = parseAgentAdmissionRuntimeConfig(process.env); } catch { return null; }
            if (!agentAdmissionAllowsSession(live, input.rawSessionId)
              || input.runId === 'missing-run' || !MODEL_USAGE_COST) return null;
            const provider = loadProviderConfig();
            const budgetProfile = foregroundSummaryBudgetProfile(
              process.env, modelRuntimeProfileFor(provider, input.client),
            );
            const tools: Record<string, unknown>[] = [];
            const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, input.client, {
              estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
              onLeaseClosed: recordAgentRuntimeLease,
              auditRequired: true,
            });
            const ticket = AGENT_ADMISSION_BROKER.issue({
              runId: input.runId,
              parentRunId: input.runId,
              sessionId: input.ticketSessionId,
              sourceRevision: input.sourceRevision,
              lane: 'maintenance',
              taskKind: 'rolling_summary',
              policyVersion: 'p14-h0-r7-foreground-summary-v1',
              modelId: provider.model,
              budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
              toolSetDigest: agentToolSetDigest(tools),
              mode: input.contentMode,
              reasonCodes: ['chat-window-truncated'],
              evidenceDigests: [input.evidenceDigest],
              noveltyDigest: input.evidenceDigest,
              expectedBenefit: 'memory-quality',
              limits: admissionLimitsFromBudgetProfile(budgetProfile),
              deadlineMs: Date.now() + budgetProfile.maxWallMs,
              allowedTools: [],
              fullSkillSnapshots: [],
              cooldownKey: `foreground-summary:${input.ticketSessionId}`,
              idempotencyKey: `admit:${input.runId}:foreground-summary:${input.evidenceDigest.slice(-16)}`,
              fallback: 'skip-optional-agent',
            });
            const lease = gateway.open({
              binding: {
                ticketId: ticket.ticketId,
                runId: ticket.runId,
                parentRunId: ticket.parentRunId,
                sessionId: ticket.sessionId,
                sourceRevision: ticket.sourceRevision,
                lane: ticket.lane,
                taskKind: ticket.taskKind,
                policyVersion: ticket.policyVersion,
                mode: ticket.mode,
                budgetProfile,
              },
              modelId: provider.model,
              tools,
            });
            const response = await lease.complete({
              model: provider.model,
              messages: [
                { role: 'system', content: '你是剧情记忆压缩器，只输出摘要正文，禁止解释、禁止输出对话。' },
                { role: 'user', content: input.prompt },
              ],
              temperature: 0.3,
              max_tokens: budgetProfile.agentOutputBudgetTokens,
            }, input.signal);
            return response.content;
          },
        }
      : {}),
    ...(AGENT_ADMISSION_RUNTIME.executionEnabled
      && MODEL_USAGE_COST
      && LEARNING_TEXT_RUNTIME.preferenceEnabled ? {
            extractPreference: async (input) => runPreferenceLearningCall(input, {
              policyVersion: 'p14-q6-preference-v1',
              reasonCode: 'initial-prompt-rule-uncertain',
              cooldownKey: `preference:${input.ticketSessionId}`,
              idempotencyKey: `admit:${input.runId}:preference-initial`,
              evidence: { promptDigest: sha256Digest(input.userPrompt) },
              modelRequest: buildPreferenceExtractionModelRequest({
                initialPrompt: input.userPrompt,
                maxOutputTokens: 1_200,
              }),
              maxOutputTokens: 1_200,
            }),
            attributeBranch: async (input) => runPreferenceLearningCall(input, {
              policyVersion: 'p14-q6-branch-semantic-v1',
              reasonCode: 'edited-branch-candidate',
              cooldownKey: `branch:${input.ticketSessionId}:${input.exposureRound}`,
              idempotencyKey: `admit:${input.runId}:branch-${input.exposureRound}`,
              evidence: {
                inputDigest: sha256Digest(input.userInput),
                candidateIndexes: input.candidates.map((candidate) => candidate.index),
                exposureRound: input.exposureRound,
              },
              modelRequest: buildBranchAttributionModelRequest({
                editedInput: input.userInput,
                candidates: input.candidates,
                branches: input.branches,
                maxOutputTokens: 600,
              }),
              maxOutputTokens: 600,
            }),
          } : {}),
    ...(AGENT_ADMISSION_RUNTIME.executionEnabled
      && MODEL_USAGE_COST
      && LEARNING_TEXT_RUNTIME.styleEnabled ? {
            requestStyleProposal: async (input) => {
              let liveAdmission;
              let livePrivacy;
              try {
                liveAdmission = parseAgentAdmissionRuntimeConfig(process.env);
                livePrivacy = parseLearningTextRuntimeConfig(process.env);
              } catch {
                return Object.freeze({
                  status: 'skipped' as const,
                  reasonCode: 'style-runtime-config-invalid' as const,
                });
              }
              const sampleChars = input.samples.reduce((sum, sample) => sum + sample.prose.length, 0);
              if (!livePrivacy.styleEnabled
                || !agentAdmissionAllowsSession(liveAdmission, input.rawSessionId)
                || input.runId === 'missing-run' || !MODEL_USAGE_COST
                || input.samples.length < 1 || input.samples.length > 8 || sampleChars > 100_000) {
                return Object.freeze({
                  status: 'skipped' as const,
                  reasonCode: 'style-admission-closed' as const,
                });
              }
              const provider = loadProviderConfig();
              const budgetProfile = agentTaskBudgetProfile(
                'style_compile', process.env, {}, modelRuntimeProfileFor(provider, input.client),
              );
              const modelRequest = buildStyleCompilationModelRequest({
                profileVersion: input.profileVersion,
                samples: input.samples,
                maxOutputTokens: budgetProfile.agentOutputBudgetTokens,
              });
              const tools = [...(modelRequest.tools ?? [])];
              const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, input.client, {
                estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
                onLeaseClosed: recordAgentRuntimeLease,
                auditRequired: true,
              });
              const ticket = AGENT_ADMISSION_BROKER.issue({
                runId: input.runId,
                parentRunId: input.runId,
                sessionId: input.ticketSessionId,
                sourceRevision: input.sourceRevision,
                lane: 'learning',
                taskKind: 'style_compile',
                policyVersion: 'p14-q7-style-compiler-v1',
                modelId: provider.model,
                budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
                toolSetDigest: agentToolSetDigest(tools),
                mode: input.contentMode,
                reasonCodes: [input.explicitRequest ? 'explicit-style-save' : 'style-evidence-threshold'],
                evidenceDigests: [input.sourceDigest],
                noveltyDigest: input.sourceDigest,
                expectedBenefit: 'style-learning',
                limits: admissionLimitsFromBudgetProfile(budgetProfile),
                deadlineMs: Date.now() + budgetProfile.maxWallMs,
                allowedTools: [STYLE_DRAFT_TOOL_NAME],
                fullSkillSnapshots: [],
                cooldownKey: `style:${input.ticketSessionId}:${input.profileVersion}`,
                idempotencyKey: `admit:${input.runId}:style:${input.sourceDigest.slice(-16)}`,
                fallback: 'skip-optional-agent',
              });
              const lease = gateway.open({
                binding: {
                  ticketId: ticket.ticketId,
                  runId: ticket.runId,
                  parentRunId: ticket.parentRunId,
                  sessionId: ticket.sessionId,
                  sourceRevision: ticket.sourceRevision,
                  lane: ticket.lane,
                  taskKind: ticket.taskKind,
                  policyVersion: ticket.policyVersion,
                  mode: ticket.mode,
                  budgetProfile,
                },
                modelId: provider.model,
                tools,
              });
              const response = await lease.complete({
                ...modelRequest,
                model: provider.model,
              }, input.signal);
              const parsed = parseLearnedStyleModelResponse(response);
              if (!parsed.ok) {
                // Fixed code only: model output and user prose must never enter server logs.
                console.warn('[StyleCompile] ' + parsed.reasonCode);
                return Object.freeze({ status: 'rejected' as const, reasonCode: parsed.reasonCode });
              }
              const draft = parsed.draft;
              try {
                const evaluation = evaluateLearnedStyleDraft({
                  draft,
                  samples: input.samples,
                  forbiddenIdentityTerms: input.forbiddenIdentityTerms,
                });
                const proposal = LEARNED_STYLE_PROPOSALS.create({
                  draft,
                  sourceDigest: input.sourceDigest,
                  profileVersion: input.profileVersion,
                  model: provider.model,
                  policyVersion: 'p14-q7-style-compiler-v1',
                  evaluation,
                  scope: input.scope,
                });
                return Object.freeze({ status: 'created' as const, proposalId: proposal.id });
              } catch {
                console.warn('[StyleCompile] style-proposal-store-rejected');
                return Object.freeze({
                  status: 'rejected' as const,
                  reasonCode: 'style-proposal-store-rejected' as const,
                });
              }
            },
          } : {}),
  };
}

const sessionLoadPromises = new Map<string, Promise<ChatSession | undefined>>();
async function loadSessionById(sessionId: string): Promise<ChatSession | undefined> {
  const loaded = sessions.get(sessionId);
  if (loaded) return loaded;
  const pending = sessionLoadPromises.get(sessionId);
  if (pending) return pending;
  const promise = (async () => {
    const dbPath = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
    if (!dbPath || !existsSync(dbPath)) return undefined;
    const session = new ChatSession({
      db: dbPath,
      resume: true,
      useBge: false,
      providerClient: providerClientForServer(),
      observeProviderClient: observeServerModelClient,
      learnedStyleResolver: learnedStyleResolverForSession(sessionId),
      interactiveHarness: interactiveHarnessForSession(sessionId),
      agentAdmission: agentAdmissionForSession(sessionId),
      quietLogs: ACCESS_MODE === 'secured',
    });
    await session.init();
    try {
      reconcileAndHydrateLearning(session);
    } catch {
      if (!learningDrainWarningEmitted) {
        learningDrainWarningEmitted = true;
        console.warn('[AgentLearning] RECONCILE_FAILED（使用 session outbox 本地投影继续）');
      }
    }
    sessions.set(sessionId, session);
    setTimeout(() => void session.warmRetrievalChannels(), 0);
    return session;
  })();
  sessionLoadPromises.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    if (sessionLoadPromises.get(sessionId) === promise) sessionLoadPromises.delete(sessionId);
  }
}

const WORLDBOOK_REPAIR_CONTROL_PLANE = WORLDBOOK_REPAIR_CONTROL
  ? new WorldbookRepairControlPlane({
      control: WORLDBOOK_REPAIR_CONTROL,
      runtime: WORLDBOOK_REPAIR_RUNTIME,
      resolveSessionBinding: async (sessionId) => {
        const session = await loadSessionById(sessionId);
        if (!session) return null;
        return Object.freeze({
          sessionId,
          worldbooks: Object.freeze([...session.getSessionConfig().worldbooks]),
        });
      },
    })
  : null;

/** 插件注册表与其他用户数据共用 JG_USER_DATA_DIR 隔离边界。 */
const pluginRegistry = new PluginRegistry(PLUGINS_DIR);
/**
 * DSH 标准插件宿主（deepseek-harness bundle 接口：package.json+main → ESM {name,inject,apply}）。
 * 宿主直跑模型（真 fs/网络），路由在 /api 之前分发。
 * 凭据解析对齐官方 credentials.resolve（每次调用即席解析，不缓存）：
 *   环境变量优先 → data/provider.json apiKey 兜底（DEEPSEEK_API_KEY / JG_API_KEY 等价复用平台已配 key）。
 */
const dshHost = new DshPluginHost(async (name) => {
  const local = readLocalEnvCredential(name);
  if (local) return local;
  if (name === 'COMMANDCODE_API_KEY') {
    try {
      const cfg = loadProviderConfig();
      if (cfg.apiKey) return { value: cfg.apiKey, source: 'provider.json' };
    } catch { /* provider.json 缺失/损坏按未配置处理 */ }
  }
  if (name === 'DEEPSEEK_API_KEY' || name === 'JG_API_KEY') {
    try {
      const cfg = loadProviderConfig();
      if (cfg.apiKey) return { value: cfg.apiKey, source: 'provider.json' };
    } catch { /* provider.json 缺失/损坏按未配置处理 */ }
  }
  return null;
}, PROVIDER_SPI_ENABLED ? {
  providerRegistrar: {
    register: (ownerId, adapter) => providerRegistry.register(ownerId, adapter),
  },
} : {});
/**
 * P7-05：失效通知 hub。eventId 是本进程内单调序号；serverInstanceId 随进程重启变化，
 * 客户端据此触发全量 refetch（/api/capabilities 已声明 features.events.replay=false）。
 */
const eventHub = new InvalidationHub({ serverInstanceId: SERVER_INSTANCE_ID });

/** TurnJobService 生命周期 → 白名单失效事件（queued/started/finished|failed|cancelled）。 */
const TURN_JOB_PHASE_EVENT: Record<'queued' | 'running' | 'settled', (job: { status: string }) => EventType> = {
  queued: () => 'turn.queued',
  running: () => 'turn.started',
  settled: (job) => job.status === 'succeeded'
    ? 'turn.finished'
    : job.status === 'cancelled' ? 'turn.cancelled' : 'turn.failed',
};

const MAINTENANCE_RUNTIME = parseMaintenanceRuntimeConfig();
const maintenanceJobs = new MaintenanceJobManager({ dataDir: DATA_DIR });
const estimateMaintenanceCost = maintenanceCostEstimator(MAINTENANCE_RUNTIME);
let maintenanceHarness: MaintenanceHarnessService | undefined;
let maintenanceAdmissionWarningEmitted = false;

const turnJobs = new TurnJobService({
  dataDir: DATA_DIR,
  serverInstanceId: SERVER_INSTANCE_ID,
  admissionOpen: releaseAdmissionOpen,
  resolveSession: (sessionId) => sessions.get(sessionId),
  loadSession: loadSessionById,
  onJobEvent: ({ job, phase }) => {
    if (phase === 'queued' || phase === 'running') maintenanceHarness?.preemptSession(job.sessionId);
    // 事件只是失效通知：携带公开 job DTO 的 status，绝不携带 prompt/正文/思维链。
    let revision: string | undefined;
    if (phase === 'settled') {
      const session = sessions.get(job.sessionId);
      if (session) {
        try { revision = snapshotForSession(session).snapshotToken; } catch { /* 客户端仍会 REST refetch */ }
      }
    }
    eventHub.publish({
      type: TURN_JOB_PHASE_EVENT[phase](job),
      resource: { kind: 'session', id: job.sessionId, ...(revision ? { revision } : {}) },
      runId: job.runId,
      requestId: job.requestId,
      data: { status: job.status },
    });
  },
  onSettled: async ({ job }) => {
    // 任务终态通知属于服务端执行生命周期，不能依赖某个 SSE 订阅者仍在线。
    const session = sessions.get(job.sessionId);
    if (!session) return;
    const learningBarrier = job.status === 'succeeded'
      ? await runSettledLearningBarrier({
          drainer: LEARNING_OUTBOX_DRAINER,
          source: session,
          hydrate: () => hydrateLearningFromLedger(session),
        })
      : null;
    if (job.status === 'succeeded' && !learningBarrier?.ok) {
      // 正文已经持久化成功，中央学习库故障不得反写 TurnJob；保留 pending，
      // 交给既有异步补偿继续搬运，但本轮维护必须 fail closed。
      scheduleLearningDrain(session);
      if (!learningDrainWarningEmitted) {
        learningDrainWarningEmitted = true;
        console.warn(`[AgentLearning] SETTLED_BARRIER_FAILED reason=${learningBarrier?.reason ?? 'unknown'}`);
      }
    }
    const usage = session.getLastUsage();
    if (job.status === 'succeeded' && usage) {
      dshHost.emitJiuguanTurn({
        sessionId: job.sessionId,
        card: session.getCardName(),
        round: job.round ?? session.getMemory().round,
        model: session.getModelName(),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
      if (MAINTENANCE_RUNTIME.enabled && maintenanceHarness) {
        // Maintenance 的 strict Arc/NPC context 来自中央 reducer；必须保证本轮
        // accepted learning 已投影可读，不能让 queueMicrotask 抢在 outbox timer 前运行。
        if (!learningBarrier?.ok) return;
        const revision = snapshotForSession(session).snapshotToken;
        let admittedTasks: readonly import('./maintenance-types.ts').MaintenanceTaskKind[] = [];
        let admissionPolicyVersion: string | null = null;
        if (MAINTENANCE_ADMISSION_RUNTIME.enabled && AGENT_ADMISSION_LEDGER) {
          try {
            const evidence = session.maintenanceAdmissionEvidence(job.runId);
            if (evidence) {
              const audits = buildMaintenanceAdmissionAudits({
                parentRunId: job.runId,
                sessionId: job.sessionId,
                sourceRevision: revision,
                observation: evidence.observation,
                domainEvidence: evidence.domainEvidence,
                foregroundActive: turnJobs.getActiveForSession(job.sessionId) !== null,
                existingJobs: maintenanceJobs.list(job.sessionId, 100),
                priorAdmissions: AGENT_ADMISSION_LEDGER.listMaintenance({ sessionId: job.sessionId }),
                nowMs: Date.now(),
                sessionBudgetLimit: MAINTENANCE_ADMISSION_RUNTIME.sessionBudgetLimit,
                dailyBudgetLimit: MAINTENANCE_ADMISSION_RUNTIME.dailyBudgetLimit,
              });
              AGENT_ADMISSION_LEDGER.recordMaintenanceBatch(audits);
              const selection = schedulePostTurnMaintenance(
                MAINTENANCE_ADMISSION_RUNTIME,
                audits,
                evidence.postTurnModelSlot,
              );
              admissionPolicyVersion = audits[0]?.decision.policyVersion ?? null;
              admittedTasks = selection.admittedTasks;
            }
          } catch {
            if (!maintenanceAdmissionWarningEmitted) {
              maintenanceAdmissionWarningEmitted = true;
              console.warn('[MaintenanceAdmission] RECORD_OR_ENFORCE_FAILED（后台入队 fail closed）');
            }
          }
        }
        if (admittedTasks.length === 0 || !admissionPolicyVersion) return;
        try {
          const queued = maintenanceHarness.enqueuePostTurn({
            sessionId: job.sessionId,
            sourceRevision: revision,
            parentRunId: job.runId,
            tasks: admittedTasks,
            policyVersion: admissionPolicyVersion,
          });
          // The shadow admission audit above remains durable when lane control
          // hard-stops execution; an empty result means no job was persisted.
          if (queued.length > 0) {
            queueMicrotask(() => { void maintenanceHarness?.drainAvailable(2); });
          }
        } catch (error) {
          if (!(error instanceof MaintenanceDisabledError)) {
            console.warn('[maintenance] post-turn enqueue failed detail=redacted');
          }
        }
      }
    } else {
      dshHost.emitSessionEvent(
        { id: job.sessionId, card: session.getCardName() },
        { type: 'turn/end', data: {} },
      );
    }
  },
});
maintenanceHarness = new MaintenanceHarnessService({
  manager: maintenanceJobs,
  budgetFor: (job) => {
    const provider = loadProviderConfig();
    return maintenanceBudgetProfileForAutonomy(
      'quality-beta',
      job.taskKind,
      process.env,
      modelRuntimeProfileFor(provider),
    );
  },
  admissionOpen: releaseAdmissionOpen,
  foregroundActive: (sessionId) => turnJobs.getActiveForSession(sessionId) !== null,
  // Rechecked by the service both before enqueue and immediately before claim.
  executionAllowed: maintenanceLaneExecutionAllowed,
  observeRuntime: (input) => {
    recordAgentControlObservation({
      lane: 'maintenance',
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      invalidCalls: input.invalidCalls,
    });
  },
  loadSnapshot: async (sessionId, taskKind) => {
    const session = await loadSessionById(sessionId);
    if (!session) throw new Error('maintenance-session-not-found');
    const revision = snapshotForSession(session).snapshotToken;
    const identity = session.learningProfileIdentity();
    const allowedArcIds = taskKind === 'branch_index' && AGENT_LEARNING_LEDGER
      ? selectArcSessionProjection(
        AGENT_LEARNING_LEDGER.arcSessionProjections(),
        identity,
      )?.arcs.map((arc) => arc.arcId)
      : undefined;
    const maintenanceSnapshot = buildMaintenanceSessionSnapshot({
      session,
      sessionId,
      revision,
      taskKind,
      allowedArcIds,
      worldbookEntries: maintenanceWorldbookEntries(session),
    });
    // 读取世界书/会话行后再次取聚合 revision；中途变化会让 service 在 Provider 前标 stale。
    const verifiedRevision = snapshotForSession(session).snapshotToken;
    if (verifiedRevision !== revision) return { ...maintenanceSnapshot, revision: verifiedRevision };
    return {
      ...maintenanceSnapshot,
      // query_memory 走会话既有异步混合检索：PG 仅作 ANN/别名召回，正文仍回查 SQLite。
      // 查询前后均校验会话 revision，且 session 侧关闭 trackAccess，保持该端口严格只读。
      readMemory: async (query: string, signal: AbortSignal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (snapshotForSession(session).snapshotToken !== revision) throw new Error('maintenance-snapshot-stale');
        const hits = await session.queryMaintenanceMemory(query, signal);
        if (snapshotForSession(session).snapshotToken !== revision) throw new Error('maintenance-snapshot-stale');
        return hits;
      },
    };
  },
  modelFor: (job, binding) => {
    if (!MAINTENANCE_RUNTIME.enabled || job.mode !== 'shadow') {
      throw new Error('maintenance-production-lane-disabled');
    }
    if (!AGENT_ADMISSION_LEDGER) throw new Error('maintenance-admission-ledger-unavailable');
    const audit = AGENT_ADMISSION_LEDGER.listMaintenance({
      parentRunId: job.parentRunId,
      sessionId: job.sessionId,
      limit: 32,
    }).find((entry) => entry.sourceRevision === job.sourceRevision
      && entry.facts.taskKind === job.taskKind
      && entry.decision.policyVersion === job.policyVersion
      && entry.decision.verdict === 'would-admit');
    if (!audit) throw new Error('maintenance-admission-audit-missing');
    const cfg = loadProviderConfig();
    const registryClient = providerClientForServer();
    if (!registryClient) assertProviderReady(cfg);
    const observed = observeServerModelClient(registryClient ?? new OpenAICompatibleClient(cfg));
    const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, observed, {
      estimateCostMicrousd: (usage) => estimateMaintenanceCost({
        model: cfg.model,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
      }),
      onLeaseClosed: recordAgentRuntimeLease,
      auditRequired: true,
    });
    const session = sessions.get(job.sessionId);
    if (!session) throw new Error('maintenance-session-not-loaded');
    return createAdmittedMaintenanceModel({
      broker: AGENT_ADMISSION_BROKER,
      gateway,
      job,
      verifiedSourceRevision: binding.verifiedSourceRevision,
      budgetProfile: binding.budgetProfile,
      modelId: cfg.model,
      mode: session.getContentMode(),
      reasonCodes: audit.decision.reasonCodes.length > 0
        ? audit.decision.reasonCodes : ['maintenance-admitted'],
      evidenceDigests: [...new Set([
        audit.decision.factsDigest,
        audit.facts.sourceDigest,
        audit.facts.observationDigest,
      ])],
      noveltyDigest: audit.facts.sourceDigest,
    });
  },
  // P13-B 首发仅 shadow；apply 接口存在于核心层供 CAS 测试，生产接线 fail closed。
  committer: {
    commit: async () => { throw new Error('maintenance-apply-disabled'); },
  },
});
const dshRuntimeErrors = new Map<string, string>();
/** 正则库（前端屏蔽隐藏 + 用户维护，数据在 data/regex-rules.json） */
const regexLibrary = new RegexLibrary();

/**
 * 会话 → 卡片文件（FE-06.0 规则来源诊断用）。
 * 会话只持有卡**显示名**，这里按显示名在已导入卡中反查文件；
 * 不依赖 session 内部字段（避免与并发改动的耦合），结果按卡名缓存。
 */
const sessionCardFileCache = new Map<string, string | null>();
function resolveSessionCardFile(cardName: string): string | null {
  if (!cardName) return null;
  const cached = sessionCardFileCache.get(cardName);
  if (cached !== undefined) return cached;
  let hit: string | null = null;
  for (const c of listCards()) {
    try {
      const parsed = parseCharaCard(readCardText(c.file)?.raw ?? '');
      if (parsed.card.name === cardName) { hit = c.file; break; }
    } catch { /* 损坏卡跳过 */ }
  }
  sessionCardFileCache.set(cardName, hit);
  return hit;
}

interface SessionSnapshotConfig {
  card?: string;
  cardFile?: string;
  worldbooks?: string[];
  preset?: string;
}

function sessionAssetRevisions(config: SessionSnapshotConfig): SessionAssetRevision[] {
  const assets: SessionAssetRevision[] = [];
  const cardName = String(config.card ?? '').trim();
  if (cardName) {
    const storedFile = String(config.cardFile ?? '').trim();
    const file = isSafeAssetFileName(storedFile) ? storedFile : resolveSessionCardFile(cardName);
    let revision: string = ABSENT_REVISION;
    if (file) {
      try { revision = readRevisionedCard(file)?.revision ?? ABSENT_REVISION; } catch { revision = ABSENT_REVISION; }
    }
    assets.push({ kind: 'card', id: file ?? cardName, revision });
  }
  const seenBooks = new Set<string>();
  for (const value of Array.isArray(config.worldbooks) ? config.worldbooks : []) {
    const file = String(value ?? '').trim();
    if (!file || seenBooks.has(file)) continue;
    seenBooks.add(file);
    const revision = isSafeAssetFileName(file)
      ? readRevisionedAsset('worldbook', file)?.revision ?? ABSENT_REVISION
      : ABSENT_REVISION;
    assets.push({ kind: 'worldbook', id: file, revision });
  }
  const preset = String(config.preset ?? '').trim();
  if (preset) {
    const revision = isSafeAssetFileName(preset)
      ? readRevisionedAsset('preset', preset)?.revision ?? ABSENT_REVISION
      : ABSENT_REVISION;
    assets.push({ kind: 'preset', id: preset, revision });
  }
  return assets;
}

function buildSessionSnapshot(memory: MemoryDb, config: SessionSnapshotConfig): SessionSnapshot {
  return aggregateSessionSnapshot(
    computeSessionDatabaseSnapshot(memory),
    sessionAssetRevisions(config),
  );
}

function snapshotForSession(session: ChatSession): SessionSnapshot {
  const config = session.getSessionConfig();
  return buildSessionSnapshot(session.getMemory().mem, config);
}

function maintenanceWorldbookEntries(session: ChatSession): unknown[] {
  const output: unknown[] = [];
  for (const file of session.getSessionConfig().worldbooks.slice(0, 16)) {
    if (!isSafeAssetFileName(file)) continue;
    try {
      const asset = readAsset('worldbook', file);
      if (!asset) continue;
      const parsed = parseWorldBook(asset.raw);
      for (const entry of parsed.entries.slice(0, 64)) {
        output.push({
          book: file,
          uid: String(entry.uid ?? '').slice(0, 160),
          keys: (entry.key ?? []).slice(0, 8).map((key) => String(key).slice(0, 160)),
          comment: String(entry.comment ?? '').slice(0, 240),
          content: String(entry.content ?? '').slice(0, 1_000),
        });
      }
    } catch { /* 损坏/竞态资产按空命中处理，不暴露路径或原始错误。 */ }
  }
  return output;
}

function json(res: ServerResponse, obj: unknown, status = 200): void {
  // SSE 等流式响应已发头后再写 JSON 会抛 ERR_HTTP_HEADERS_SENT 并**崩溃进程**。
  // 这里守卫：已发头则不再改状态/头，直接尽力收尾。
  if (res.headersSent) {
    try { res.end(); } catch { /* 连接可能已断开 */ }
    return;
  }
  res.statusCode = status;
  const payload = JSON.stringify(AUTH_RUNTIME && status >= 400
    ? remoteErrorPayload(res, obj, status)
    : obj);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload);
}

function revisionJson(
  res: ServerResponse,
  obj: Record<string, unknown>,
  revision: string,
  status = 200,
): void {
  if (revision !== ABSENT_REVISION) res.setHeader(REVISION_HEADER, formatStrongEtag(revision));
  json(res, { ...obj, revision }, status);
}

/** P7-08：所有实体写入必须先通过唯一强 If-Match；失败时不读取正文、不进入存储层。 */
function expectedRevision(req: IncomingMessage, res: ServerResponse): string | null {
  const parsed = parseIfMatch(req.headers[EXPECTED_REVISION_HEADER.toLowerCase()]);
  if (parsed.ok) return parsed.revision;
  if (parsed.reason === 'missing') {
    json(res, {
      error: {
        code: 'precondition_required',
        message: '请先读取资源并携带 If-Match；新建资源使用 "absent"',
      },
    }, 428);
  } else {
    json(res, { error: { code: 'bad_request', message: 'If-Match 必须是单个强实体 ETag' } }, 400);
  }
  return null;
}

function assetConflict(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof AssetRevisionConflictError)) return false;
  revisionConflict(res, error.expectedRevision, error.actualRevision, `${error.kind}:${error.file}`);
  return true;
}

function revisionConflict(
  res: ServerResponse,
  expected: string,
  actual: string,
  resourceId: string,
): void {
  json(res, {
    error: {
      code: 'conflict',
      message: '资源已被另一客户端修改，请重新加载后合并本地草稿',
      details: {
        expectedRevision: expected,
        actualRevision: actual,
        resourceId,
      },
    },
  }, 409);
}

/** DSH 网关自身错误保持同源，不沿用核心 API 的临时 wildcard CORS。 */
function dshJson(res: ServerResponse, obj: unknown, status: number): void {
  if (res.headersSent) {
    try { res.end(); } catch { /* 连接可能已断开 */ }
    return;
  }
  res.statusCode = status;
  const payload = JSON.stringify(AUTH_RUNTIME && status >= 400
    ? remoteErrorPayload(res, obj, status)
    : obj);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  // 与 json() 对齐：错误正文也不允许浏览器嗅探成其它类型。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload);
}

/**
 * 插件管理（P5.2 起属 admin 级）失败的公开错误：稳定 code + 公开文案 + requestId。
 *
 * 插件安装/更新的原始异常经常包含**插件绝对 source 路径**或备份目录，直接回传等于
 * 向客户端泄漏本机布局。这里只回传稳定 code 与公开文案，原始信息写入本机 console。
 *
 * 其余业务路由的批量迁移属于 P5.2-A6-03「公开错误映射与 canary 扫描」，不在 A0-02 内。
 */
function pluginAdminError(
  res: ServerResponse,
  requestId: string,
  status: 400 | 500,
  code: string,
  message: string,
  detail: unknown,
): void {
  void detail;
  console.warn(`[Plugin] ${code} requestId=${requestId} detail=redacted`);
  dshJson(res, { error: message, code, requestId }, status);
}

/**
 * 精确 route template 匹配：`:` 前缀的段表示"恰好一个非空 segment"。
 *
 * 用来替换 `p.startsWith('/api/session/') && p.endsWith('/quiet')` 这类组合。后者会接受
 * `/api/session/a/b/quiet`（把 `a` 当 sessionId，静默忽略 `b`），使路由空间不是良定义的
 * 模板集合，也无法为 P5.2-A4 的 route manifest 建立 method + 模板映射。
 *
 * 字面量段大小写敏感、段数必须完全一致；不匹配返回 null，调用方按 404 处理。
 */
function matchRouteTemplate(template: string, pathname: string): Record<string, string> | null {
  const templateSegments = template.split('/');
  const pathSegments = pathname.split('/');
  if (templateSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index++) {
    const expected = templateSegments[index];
    const actual = pathSegments[index];
    if (expected === undefined || actual === undefined) return null;
    if (expected.startsWith(':')) {
      if (actual.length === 0) return null;
      params[expected.slice(1)] = actual;
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/** 客户端提交的资产文件名：必须通过单段文件名守卫，否则按 400 拒绝（不落到 resolveAsset 的 null 上）。 */
function readAssetFileName(value: unknown): string | null {
  return isSafeAssetFileName(value) ? value : null;
}

function assetDisplayName(file: string): string {
  return file.replace(/\.(json|png)$/i, '');
}

function ensureAssetIdentity(kind: 'card' | 'preset' | 'worldbook', file: string, displayName?: string): LocalAssetIdentity {
  const current = ASSET_IDENTITIES.findByStorageKey(kind, file);
  if (current && displayName === undefined) return current;
  return ASSET_IDENTITIES.ensure(kind, file, displayName?.trim() || assetDisplayName(file));
}

/**
 * 新客户端提交 opaque assetId；旧客户端在兼容期仍可提交单段文件名。
 * 返回值始终是服务端 manifest 中解析出的 storageKey 或经单段守卫验证的 legacy key。
 */
function readAssetReference(kind: 'card' | 'preset' | 'worldbook', value: unknown): string | null {
  return ASSET_IDENTITIES.resolveReference(kind, value)?.storageKey ?? null;
}

/** 新上传始终使用服务端生成的内部键；客户端 filename/displayName 不参与路径。 */
function allocateUploadedStorageKey(kind: 'card' | 'preset' | 'worldbook'): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const file = `upload-${randomUUID().replaceAll('-', '').slice(0, 24)}.json`;
    if (!readRevisionedAsset(kind, file) && !ASSET_IDENTITIES.findByStorageKey(kind, file)) return file;
  }
  throw new Error('无法分配上传资产内部键');
}

/**
 * 资产读取路由的精确模板匹配：只接受 `<prefix>/<单个文件名段>/<suffix...>`。
 *
 * 返回已解码且通过单段守卫的文件名，或 null（路由形状不符 / 非法转义 / 文件名不安全）。
 * 此前这些路由用 `p.slice(prefix.length, -suffix.length)` 取值，`/api/card/a/b/raw`
 * 会被接受并把 `a/b` 当文件名交给 resolveCard（该函数原先也不做校验），
 * 形成客户端可控的任意文件读取。
 */
function assetRouteFile(template: string, pathname: string): string | null {
  const params = matchRouteTemplate(template, pathname);
  if (!params || params.file === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(params.file);
  } catch {
    return null;
  }
  return readAssetFileName(decoded);
}

function assetRouteReference(
  kind: 'card' | 'preset' | 'worldbook',
  template: string,
  pathname: string,
): string | null {
  const reference = assetRouteFile(template, pathname);
  return reference === null ? null : readAssetReference(kind, reference);
}

function providerFailureStatus(error: ProviderRegistryError): number {
  if (error.code === 'not-found') return 404;
  if (error.code === 'not-configured') return 409;
  if (error.code === 'capability-disabled' || error.code === 'method-unavailable') return 422;
  if (error.code === 'recursive-call') return 409;
  if (error.code === 'invocation-aborted') return 409;
  if (error.code === 'invocation-forced') return 503;
  return 502;
}

/** Provider 管理 API 只返回 Registry 的稳定错误，不透传插件/上游原始异常。 */
function providerFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof ProviderRegistryError) {
    json(res, { ok: false, code: error.code, error: error.message }, providerFailureStatus(error));
    return;
  }
  console.warn('[Provider] 管理调用发生内部错误（详情已隐藏）');
  json(res, { ok: false, code: 'provider-management-failed', error: 'Provider 管理操作失败' }, 500);
}

function providerActionPath(pathname: string): { id: string; action: 'models' | 'health' } | null {
  const match = /^\/api\/providers\/([^/]+)\/(models|health)$/.exec(pathname);
  if (!match) return null;
  try {
    return {
      id: decodeURIComponent(match[1]!),
      action: match[2]! as 'models' | 'health',
    };
  } catch {
    return null;
  }
}

/** SSE 初始化 */
function sse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Accel-Buffering', 'no');
  try { res.flushHeaders(); } catch { /* response may already be closed */ }
}
function sseSend(res: ServerResponse, obj: unknown): void {
  // 客户端已断开/响应已结束时不写（中止生成后 res 可能已 close）
  if (res.writableEnded || res.destroyed) return;
  let payload = obj;
  if (AUTH_RUNTIME && obj && typeof obj === 'object'
    && (obj as Record<string, unknown>).type === 'error') {
    const error = remoteErrorPayload(res, obj, 500);
    payload = { type: 'error', message: error.error.message, ...error };
  }
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* 客户端已断开 */ }
}

/** Keep Tailnet/mobile intermediaries from treating a thinking model as a dead stream. */
function startTurnSseHeartbeat(res: ServerResponse): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(': hb\n\n'); } catch { /* client disconnected */ }
  }, 15_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function turnJobFailureMessage(action: 'turn' | 'regenerate', code: string | undefined): string {
  switch (code) {
    case 'provider_failed': return '模型服务调用失败，请稍后重试';
    case 'provider_not_configured': return '模型服务尚未配置，请先完成 Provider 设置';
    case 'provider_unavailable': return '当前模型 Provider 不可用，请检查内置插件是否启用';
    case 'provider_capability_unavailable': return '当前模型 Provider 不支持本次请求';
    case 'provider_reloaded': return '模型 Provider 正在重载，请稍后重试';
    case 'provider_interrupted': return '模型服务调用被中断，请重试';
    case 'execution_lease_lost': return '生成任务执行权已失效，请重试';
    case 'skill_context_conflict': return '完整 Skill 与必需上下文超出模型容量，请调整上下文配置';
    default: return action === 'regenerate' ? '重新生成失败，请重试' : '回合生成失败，请重试';
  }
}

/** 读 body（按路径选择限流档位）；实现见 security.ts readLimitedBody（超限保留连接以便回写 413） */
function readBody(req: IncomingMessage, limit = bodyLimitForPath(new URL(req.url ?? '/', `http://${HOST}`).pathname)): Promise<Record<string, unknown>> {
  return readLimitedBody(req, limit);
}

/**
 * P3 本地 DSH 网关顺序：
 * URL → 全局 OPTIONS →（P5 才加入设备认证）→ body framing/上限 → /ext 分发 → 核心路由。
 * DSH handler 仍接收原始流，因此有 body 的方法必须使用 Content-Length；拒绝 chunked，
 * 才能在插件读取任何字节前完成确定性上限检查。服务在 P5 前仍严格绑定 127.0.0.1。
 */
function admitDshBody(req: IncomingMessage, res: ServerResponse): boolean {
  const method = req.method ?? 'GET';
  const transferEncoding = req.headers['transfer-encoding'];
  const contentLength = req.headers['content-length'];
  if (transferEncoding !== undefined) {
    req.resume();
    dshJson(res, { error: 'DSH 路由不接受 Transfer-Encoding/chunked；请发送 Content-Length' }, 400);
    return false;
  }
  if (['POST', 'PUT', 'PATCH'].includes(method) && contentLength === undefined) {
    req.resume();
    dshJson(res, { error: 'DSH 写请求必须携带 Content-Length' }, 411);
    return false;
  }
  try {
    assertContentLength(req, BODY_LIMITS.json);
    return true;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      req.resume();
      dshJson(res, { error: error.message, limit: error.limit }, 413);
      return false;
    }
    throw error;
  }
}

/** 插件安装/启停/更新/卸载串行化，避免磁盘切换与 owner 生命周期相互踩踏。 */
let pluginMutationTail: Promise<void> = Promise.resolve();
function runPluginMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = pluginMutationTail.then(work, work);
  pluginMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

/** 让插件的静态 configured descriptor 重新读取宿主凭据；不存在/禁用时保持无副作用。 */
async function refreshCommandCodeProviderCredentialState(): Promise<void> {
  if (!PROVIDER_SPI_ENABLED) return;
  const record = pluginRegistry.get(COMMANDCODE_PROVIDER_PLUGIN_ID);
  if (!record || !record.enabled || record.kind !== 'dsh') return;
  await runPluginMutation(() => reloadDshPlugin(COMMANDCODE_PROVIDER_PLUGIN_ID));
}

const IMAGE_ATTACHMENT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_TURN_IMAGES = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES_TOTAL = 6 * 1024 * 1024;

function parseImageAttachments(raw: unknown): ImageAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('attachments 必须是数组');
  if (raw.length > MAX_TURN_IMAGES) throw new Error(`单轮最多发送 ${MAX_TURN_IMAGES} 张图片`);
  let total = 0;
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${i + 1} 个附件格式无效`);
    const a = item as Record<string, unknown>;
    if (a.kind !== 'image') throw new Error('当前仅支持 image 附件');
    const mime = String(a.mime ?? '');
    if (!IMAGE_ATTACHMENT_MIMES.has(mime)) throw new Error(`不支持的图片类型: ${mime || 'unknown'}`);
    const dataUrl = String(a.dataUrl ?? '');
    const prefix = `data:${mime};base64,`;
    if (!dataUrl.startsWith(prefix)) throw new Error(`第 ${i + 1} 张图片 dataUrl 与 mime 不匹配`);
    const size = Number(a.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`第 ${i + 1} 张图片大小无效`);
    if (size > MAX_IMAGE_BYTES) throw new Error(`单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`);
    total += size;
    if (total > MAX_IMAGE_BYTES_TOTAL) throw new Error(`单轮图片总大小不能超过 ${Math.round(MAX_IMAGE_BYTES_TOTAL / 1024 / 1024)}MB`);
    return {
      kind: 'image' as const,
      name: typeof a.name === 'string' ? a.name.slice(0, 120) : undefined,
      mime: mime as ImageAttachment['mime'],
      dataUrl,
      size,
    };
  });
}

function parseBranchSelection(raw: unknown): BranchSelectionReference | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('branchSelection 必须是对象');
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== 'round' && key !== 'branchId')
    || !Number.isSafeInteger(row.round) || Number(row.round) < 1
    || typeof row.branchId !== 'string' || !/^branch:[a-f0-9]{24}$/u.test(row.branchId)) {
    throw new Error('branchSelection 非法');
  }
  return { round: Number(row.round), branchId: row.branchId };
}

/** 模拟流式分块（按标点/换行/60 字切） */
function chunkText(text: string, size = 60): string[] {
  const out: string[] = [];
  const parts = text.split(/(?<=[。！？\n；])/);
  let buf = '';
  for (const p of parts) {
    buf += p;
    if (buf.length >= size || p.includes('\n')) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 读取会话摘要（卡名/最新消息预览/轮次/开始文字/创建时间；HTML 清洗后截断） */
function readSessionMeta(dbPath: string): {
  card: string;
  preview: string;
  round: number;
  start: string;
  createdAt: string;
  revision: string | null;
  snapshotToken: string | null;
} {
  try {
    const mem = new MemoryDb({ path: dbPath });
    try {
      const meta = mem.db.prepare('SELECT config FROM memory_meta WHERE id = 1').get() as { config: string } | undefined;
      const cfg = meta ? (JSON.parse(meta.config ?? '{}') as SessionSnapshotConfig) : {};
      // 预览优先取"非开场白的最后一条 assistant"（开场白常含 HTML/CSS 围栏，预览难读）
      const last = (
        mem.db.prepare("SELECT content FROM chat_log WHERE role='assistant' AND round > 0 ORDER BY id DESC LIMIT 1").get()
        ?? mem.db.prepare("SELECT content FROM chat_log WHERE role='assistant' ORDER BY id DESC LIMIT 1").get()
      ) as { content: string } | undefined;
      const first = mem.db.prepare("SELECT content, created_at FROM chat_log ORDER BY id ASC LIMIT 1").get() as { content: string; created_at?: string } | undefined;
      const r = mem.db.prepare('SELECT COALESCE(MAX(round), 0) AS m FROM chat_log').get() as { m: number };
      const snapshot = buildSessionSnapshot(mem, cfg);
      const strip = (t: string) => t
        .replace(/```[^\n]*\n?/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\s+/g, ' ').trim();
      const start = first?.content ? strip(first.content).slice(0, 100) : '';
      const createdAt = first?.created_at
        ?? (() => { try { return statSync(dbPath).mtime.toISOString(); } catch { return ''; } })();
      return {
        card: cfg.card ?? '',
        preview: last?.content ? strip(last.content).slice(0, 42) : '',
        round: r?.m ?? 0,
        start,
        createdAt,
        revision: snapshot.snapshotToken,
        snapshotToken: snapshot.snapshotToken,
      };
    } finally {
      mem.close();
    }
  } catch {
    return {
      card: '', preview: '', round: 0, start: '', createdAt: '',
      // 已存在却不可读取的 DB 绝不能伪装成 absent，否则删除 CAS 会 fail-open。
      revision: null, snapshotToken: null,
    };
  }
}

/** 分镜完成载荷（/api/storyboard/run 与 /api/session/:id/director 共用；含下载用全量 Markdown，探窗展示/下载复用） */
function storyboardDonePayload(
  result: StoryboardResult,
  opts: { sceneName?: string; directorSource?: string } = {},
): Record<string, unknown> {
  return {
    type: 'done',
    passed: result.passed,
    voice: result.directorsRead?.voice ?? '',
    intention: result.directorsRead?.intention ?? '',
    // panels 全字段下发（H3 视频提示词按需转写的回传输入；localhost SSE 载荷无压力）
    panels: result.panels,
    sequence: result.sequence ? {
      master_prompt: result.sequence.master_prompt.slice(0, 400), narrative: result.sequence.narrative.slice(0, 400),
      consistency: result.sequence.consistency.slice(0, 200), sfx: result.sequence.sfx,
    } : null,
    humanized: result.humanized?.summary ?? '',
    validation: result.validation,
    errors: result.errors.slice(0, 12),
    warnings: result.warnings.slice(0, 12),
    markdown: renderDirectorMarkdown({
      sceneName: opts.sceneName,
      directorSource: opts.directorSource,
      voice: result.directorsRead?.voice ?? '',
      intention: result.directorsRead?.intention ?? '',
      panels: result.panels,
      sequence: result.sequence,
      humanized: result.humanized,
      validation: result.validation,
    }),
  };
}

/** H3 视频提示词完成载荷（/api/storyboard/video-prompt 与 /api/session/:id/director/video-prompt 共用） */
function videoPromptDonePayload(result: VideoPromptResult): Record<string, unknown> {
  return {
    type: 'done',
    passed: result.passed,
    speakers: result.speakers,
    prompts: result.prompts,
    validation: result.validation,
    errors: result.errors.slice(0, 12),
    warnings: result.warnings.slice(0, 12),
    markdown: result.markdown,
  };
}

/** 前端回传面板重校验（PanelsSchemaLenient 容错；上限 30 对齐分镜管线） */
function parseVideoPromptPanels(raw: unknown): Panel[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const parsed = safeParseStage(JSON.stringify({ panels: raw }), PanelsSchemaLenient);
  return parsed ? parsed.panels.slice(0, 30) : [];
}

function assetPurposeForUrl(value: string): AssetCapabilityPurpose | null {
  const media = mimeForUrl(value).toLowerCase();
  if (media.startsWith('image/')) return 'image';
  if (media.startsWith('font/')) return 'font';
  if (media === 'text/css') return 'style';
  if (media === 'text/javascript' || media === 'application/javascript') return 'script';
  if (media.startsWith('audio/')) return 'audio';
  if (media.startsWith('video/')) return 'video';
  return null;
}

function publicAssetDescriptor(entry: {
  id: string;
  kind: PublicAssetDescriptor['kind'];
  name: string;
  cached: boolean;
  bytes?: number;
  sourceCard?: string;
}): PublicAssetDescriptor {
  return {
    assetId: entry.id,
    kind: entry.kind,
    displayName: entry.name,
    cached: entry.cached,
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    ...(entry.sourceCard === undefined ? {} : { sourceCard: entry.sourceCard }),
  };
}

type AssetByteRange =
  | { kind: 'full'; start: 0; end: number; length: number }
  | { kind: 'partial'; start: number; end: number; length: number };

function parseAssetRange(value: string | undefined, size: number): AssetByteRange | null {
  if (value === undefined) return { kind: 'full', start: 0, end: size - 1, length: size };
  if (value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  }
  if (start < 0 || end < start || start >= size || end >= size) return null;
  return { kind: 'partial', start, end, length: end - start + 1 };
}

const server = createServer(async (req, res) => {
  let securityAuditSpan: SecurityAuditSpan | null = null;
  try {
    const incomingRequestId = Array.isArray(req.headers['x-request-id'])
      ? req.headers['x-request-id'][0]
      : req.headers['x-request-id'];
    const requestId = isSafeOpaqueId(incomingRequestId) ? incomingRequestId : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    const initialPolicy = matchRouteAccess(method, p);
    securityAuditSpan = SECURITY_AUDIT ? new SecurityAuditSpan({
      writer: SECURITY_AUDIT,
      requestId,
      action: method,
      routeTemplate: initialPolicy?.template
        ?? (!p.startsWith('/api') && !p.startsWith('/ext') && p !== '/health' ? 'static' : 'unmatched'),
    }) : null;
    const auditFinish = (status: number, reasonCode?: string): void => {
      const rawLength = res.getHeader('content-length');
      const parsedLength = typeof rawLength === 'number'
        ? rawLength
        : typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
      const contentType = String(res.getHeader('content-type') ?? '');
      securityAuditSpan?.finish({
        status,
        bytes: parsedLength,
        stream: contentType.startsWith('text/event-stream'),
        ...(reasonCode ? { reasonCode } : {}),
      });
    };
    res.once('finish', () => auditFinish(res.statusCode));
    res.once('close', () => auditFinish(res.writableFinished ? res.statusCode : 499, 'request-aborted'));
    res.once('error', () => auditFinish(500, 'response-error'));

    // Host/authority 必须先于静态文件和 API 校验，阻断 DNS rebinding 的无 Origin 同源读取。
    const authority = evaluateHttpAuthority(req.headers, req.rawHeaders, ALLOWED_AUTHORITIES);
    if (!authority.ok) {
      req.resume();
      securityAuditSpan?.annotate({ reasonCode: authority.code });
      return dshJson(res, {
        error: '请求主机未获允许',
        code: authority.code,
        requestId,
      }, authority.status);
    }

    // P6-03a：Capacitor/Bundled app 的 CORS 预检是独立前置管线。它只认显式 app origin
    // 与 route manifest，不认证、不读取 body，也绝不进入静态、插件或业务 handler。
    const corsPreflight = evaluateCorsPreflight({
      method,
      pathname: p,
      headers: req.headers,
      rawHeaders: req.rawHeaders,
    }, APP_ORIGINS);
    if (corsPreflight.handled) {
      if (!corsPreflight.allowed) {
        res.setHeader('Connection', 'close');
        securityAuditSpan?.annotate({ reasonCode: corsPreflight.code });
        return dshJson(res, {
          error: '跨源预检未获允许',
          code: corsPreflight.code,
          requestId,
        }, corsPreflight.status);
      }
      securityAuditSpan?.annotate({ reasonCode: 'cors-preflight' });
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', corsPreflight.origin);
      res.setHeader('Access-Control-Allow-Methods', corsPreflight.method);
      if (corsPreflight.headers.length > 0) {
        res.setHeader('Access-Control-Allow-Headers', corsPreflight.headers.join(', '));
      }
      res.setHeader(
        'Vary',
        'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    // P6-03b：actual app-origin 请求先安装统一响应头，再进入现有 policy/auth/handler。
    // 跨源 Cookie/CSRF 与未登记 route 在这里终止；Bearer 仍由后续 AuthRuntime 验证。
    const corsActual = evaluateCorsActual({
      method,
      pathname: p,
      headers: req.headers,
      rawHeaders: req.rawHeaders,
    }, APP_ORIGINS);
    if (corsActual.handled) {
      if (corsActual.origin) {
        applyActualCorsHeaders(res, { origin: corsActual.origin, method, pathname: p });
      }
      if (!corsActual.allowed) {
        req.resume();
        securityAuditSpan?.annotate({ reasonCode: corsActual.code });
        return dshJson(res, {
          error: '跨源请求未获允许',
          code: corsActual.code,
          requestId,
        }, corsActual.status);
      }
    }

    // 生产 Web 与 API 共用同一 loopback 入口；静态处理器绝不接管 /api、/ext、/health。
    if (serveStaticWeb(req, res, { rootDir: WEB_DIST_DIR })) return;

    // P5.1 中央策略先于任何 DSH/API 路由执行。它不信任 remoteAddress/Host/代理头；
    // P5.2 设备认证会在同一位置继续执行 route.access 的默认拒绝。
    const policy = evaluateHttpPolicy(
      { method, pathname: p, headers: req.headers },
      ALLOWED_ORIGINS,
      APP_ORIGINS,
    );
    if (!policy.ok) {
      req.resume();
      securityAuditSpan?.annotate({ reasonCode: policy.code });
      return dshJson(res, {
        error: policy.code === 'json-required'
          ? '写操作必须使用 application/json'
          : policy.code === 'multipart-required'
            ? '该上传入口必须使用 multipart/form-data 并携带 boundary'
            : '请求来源未获允许',
        code: policy.code,
        requestId,
      }, policy.status);
    }

    // 非 CORS OPTIONS 仍由宿主消费，绝不进入插件，也不发送跨源许可头。
    if (method === 'OPTIONS') {
      securityAuditSpan?.annotate({ reasonCode: 'options' });
      res.statusCode = 204;
      res.setHeader('Allow', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }

    if (method === 'GET' && p === '/health') {
      securityAuditSpan?.annotate({ reasonCode: 'health' });
      return json(res, { ok: true, app: 'jiuguan', version: APP_VERSION });
    }

    if (method === 'GET' && p === '/api/capabilities') {
      securityAuditSpan?.annotate({ reasonCode: 'capabilities' });
      if (AGENT_RUNTIME_PROFILE) res.setHeader('X-JG-Agent-Runtime-Profile', AGENT_RUNTIME_PROFILE);
      const buildSha = process.env.JG_BUILD_SHA?.trim();
      const meta: ServerMeta = {
        app: {
          name: 'jiuguan',
          version: APP_VERSION,
          ...(buildSha ? { buildSha } : {}),
        },
        api: {
          protocolVersion: API_PROTOCOL_VERSION,
          minClientProtocol: MIN_CLIENT_PROTOCOL_VERSION,
          maxClientProtocol: MAX_CLIENT_PROTOCOL_VERSION,
        },
        serverId: INSTALLATION_IDENTITY.serverId,
        serverInstanceId: SERVER_INSTANCE_ID,
        now: new Date().toISOString(),
        features: {
          providerRegistry: { version: 1 },
          maintenanceHarness: {
            version: 1,
            available: MAINTENANCE_RUNTIME.enabled,
            mode: 'shadow',
          },
          interactiveHarness: {
            version: 1,
            available: INTERACTIVE_RUNTIME.enabled,
            mode: INTERACTIVE_RUNTIME.lane,
            writesEnabled: INTERACTIVE_RUNTIME.lane === 'on'
              && INTERACTIVE_RUNTIME.variableSpecs.length > 0,
          },
          events: { version: 1, replay: true, bounded: true },
          fileTransfer: {
            version: 1,
            maxImportBytes: ASSET_UPLOAD_LIMITS.maxFileBytes,
            streamingUpload: true,
            resumableUpload: false,
            uploadPath: '/api/assets/import',
            authenticatedDownload: AUTH_RUNTIME !== null,
            downloadGrantPath: '/api/assets/download-capabilities',
            downloadPathTemplate: '/api/assets/download/{assetId}/{format}',
          },
          productionWeb: { version: 1, sameOrigin: true, available: existsSync(WEB_DIST_DIR) },
          remoteSecurity: {
            version: 1,
            ready: AUTH_RUNTIME !== null && PUBLIC_HTTPS.origins.size > 0,
            authReady: AUTH_RUNTIME !== null,
            httpsReady: PUBLIC_HTTPS.origins.size > 0,
          },
        },
        providers: providerRegistry.list(),
        auth: ACCESS_MODE === 'secured'
          ? {
              required: true,
              transports: ['same-origin-cookie', 'bearer'],
              pairingEnabled: true,
              sessionEndpoint: '/api/auth/session',
            }
          : { required: false, pairingEnabled: false },
      };
      return json(res, meta);
    }

    // P5.2-A2-02：一次性配对（public 路由，仅 secured 模式存在）。
    // pre-body 顺序：限流 → 4 KiB 流式上限 → 绝对 deadline → 严格 JSON → 契约 guard
    // → 恒时配对状态机（pairWithCode）。
    if (method === 'POST' && p === '/api/auth/pair') {
      if (!AUTH_RUNTIME) {
        req.resume();
        return dshJson(res, { error: '认证未启用', code: 'auth-disabled', requestId }, 404);
      }
      const remoteKey = req.socket?.remoteAddress ?? 'unknown';
      const pairAdmission = AUTH_PAIR_ADMISSION.admit(remoteKey);
      if (!pairAdmission.allowed) {
        req.resume();
        securityAuditSpan?.annotate({ reasonCode: pairAdmission.reason });
        res.setHeader('Retry-After', String(pairAdmission.retryAfterSeconds));
        return dshJson(res, { error: '请求过于频繁，请稍后再试', code: 'rate-limited', requestId }, 429);
      }
      bindAdmissionLease(pairAdmission.lease, req, res);
      let body: Record<string, unknown>;
      try {
        body = await readLimitedBody(req, BODY_LIMITS.authPair, { deadlineMs: 10_000 });
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          securityAuditSpan?.annotate({ reasonCode: 'payload-too-large' });
          return dshJson(res, { error: '请求体过大', code: 'payload-too-large', requestId }, 413);
        }
        if (error instanceof BodyDeadlineError) {
          securityAuditSpan?.annotate({ reasonCode: 'body-deadline' });
          return dshJson(res, { error: '请求体超时', code: 'body-deadline', requestId }, 408);
        }
        securityAuditSpan?.annotate({ reasonCode: 'json-invalid' });
        return dshJson(res, { error: '请求体必须是合法 JSON', code: 'json-invalid', requestId }, 400);
      }
      const outcome = AUTH_RUNTIME.pair(body, () => new Date().toISOString());
      switch (outcome.kind) {
        case 'bad-request':
          securityAuditSpan?.annotate({ reasonCode: 'pair-request-invalid' });
          return dshJson(res, { error: '配对请求形状不正确', code: 'pair-request-invalid', requestId }, 400);
        case 'invalid':
          securityAuditSpan?.annotate({ reasonCode: 'pair-invalid' });
          // 统一公开失败：错码/不存在/过期/撤销/耗尽/已消费/并发败者共用同一响应。
          return dshJson(res, { error: '配对失败：配对码无效、过期或已使用', code: 'pair-invalid', requestId }, 401);
        case 'transport-not-allowed':
          securityAuditSpan?.annotate({ reasonCode: 'transport-not-allowed' });
          return dshJson(res, { error: '该配对码不允许此传输方式', code: 'transport-not-allowed', requestId }, 403);
        case 'scope-not-allowed':
          securityAuditSpan?.annotate({ reasonCode: 'scope-not-allowed' });
          return dshJson(res, { error: '请求的 scope 超出配对码授权', code: 'scope-not-allowed', requestId }, 403);
        case 'ok-bearer':
          securityAuditSpan?.annotate({
            reasonCode: 'pair-ok',
            deviceId: outcome.device.id,
            sessionPublicId: outcome.session.sessionId,
          });
          // Bearer 明文只在本次 JSON 返回一次；响应丢失不补发，需重新配对。
          return json(res, {
            transport: 'bearer',
            device: outcome.device,
            session: outcome.session,
            tokenType: 'Bearer',
            accessToken: outcome.sessionCredential,
          });
        case 'ok-cookie': {
          securityAuditSpan?.annotate({
            reasonCode: 'pair-ok',
            deviceId: outcome.device.id,
            sessionPublicId: outcome.session.sessionId,
          });
          // __Host- 前缀强制 Secure + Path=/ + 无 Domain（架构裁决：即使当前是
          // HTTP loopback 也不去掉 Secure；secured 的浏览器入口是配置后的私有 HTTPS origin）。
          res.setHeader(
            'Set-Cookie',
            `__Host-jg_session=${outcome.sessionCredential}; Secure; HttpOnly; SameSite=Strict; Path=/`,
          );
          // Cookie 模式的响应 JSON 绝不出现 accessToken（契约约束）。
          return json(res, {
            transport: 'same-origin-cookie',
            device: outcome.device,
            session: outcome.session,
          });
        }
      }
    }

    // -----------------------------------------------------------------
    // P5.2-A4：中央 route manifest + 单点 authn/authz/CSRF。secured 模式
    // 未登记路由默认拒绝；认证失败不读 body、不进 handler/DSH/上游/SSE。
    // -----------------------------------------------------------------
    const authGuardFailure = (status: number, code: string, message: string): void => {
      req.resume();
      securityAuditSpan?.annotate({ reasonCode: code });
      res.setHeader('Connection', 'close');
      dshJson(res, { error: message, code, requestId }, status);
    };
    let authenticatedContext: AuthenticatedContext | null = null;
    let requestAbortController: AbortController | null = null;
    const routeAccess = matchRouteAccess(method, p);
    if (AUTH_RUNTIME && routeAccess?.access !== 'public') {
      if (!routeAccess || routeAccess.access !== 'protected') {
        return authGuardFailure(404, 'route-denied', '路由未开放');
      }
      const extraction = extractPresentedCredential(req.headers);
      if (extraction.kind === 'invalid') {
        return authGuardFailure(400, extraction.reason, '凭据头形状不正确');
      }
      if (extraction.kind === 'none') {
        return authGuardFailure(401, 'auth-required', '需要认证');
      }
      authenticatedContext = AUTH_RUNTIME.authenticate(
        { transport: extraction.transport, value: extraction.value },
        () => new Date().toISOString(),
      );
      if (authenticatedContext === null || authenticatedContext.session === null) {
        return authGuardFailure(401, 'auth-invalid', '认证失败');
      }
      securityAuditSpan?.annotate({
        deviceId: authenticatedContext.device.deviceId,
        sessionPublicId: authenticatedContext.session.publicId,
        ...(routeAccess.scope ? { requiredScope: routeAccess.scope } : {}),
      });
      const unsafeMethod = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
      const csrfRequired = routeAccess.csrf === 'always' || (routeAccess.csrf === 'unsafe' && unsafeMethod);
      if (authenticatedContext.transport === 'same-origin-cookie' && csrfRequired) {
        if (policy.client !== 'browser' || policy.origin === undefined) {
          return authGuardFailure(403, 'csrf-origin-required', 'Cookie 写请求需要允许的 Origin');
        }
        const csrf = extractCsrfToken(req.headers);
        if (csrf.kind === 'none') {
          return authGuardFailure(403, 'csrf-required', 'Cookie 写请求需要 CSRF token');
        }
        if (csrf.kind === 'invalid') {
          return authGuardFailure(400, 'csrf-header-invalid', 'CSRF 头形状不正确');
        }
        if (!AUTH_RUNTIME.verifyCsrfToken(csrf.value, authenticatedContext.session)) {
          return authGuardFailure(403, 'csrf-invalid', 'CSRF token 无效');
        }
      }
      const authorization = decideRouteAccess(routeAccess, {
        kind: 'authenticated',
        scopes: authenticatedContext.device.scopes,
      });
      if (!authorization.allowed) {
        return authGuardFailure(
          authorization.status,
          authorization.code,
          `需要 ${routeAccess.scope} scope`,
        );
      }
      const rateGroup = routeAccess.rateGroup as ProtectedRateGroup;
      const sessionSelector = authenticatedContext.session.selector;
      const deviceId = authenticatedContext.device.deviceId;
      const assetTarget = rateGroup === 'assets' ? ':' + p : '';
      const admission = AUTH_REQUEST_ADMISSION.admit({
        group: rateGroup,
        rateKey: deviceId + ':' + sessionSelector + ':' + rateGroup + assetTarget,
        concurrencyKey: deviceId + ':' + rateGroup,
      });
      if (!admission.allowed) {
        res.setHeader('Retry-After', String(admission.retryAfterSeconds));
        return authGuardFailure(
          429,
          admission.reason,
          admission.reason === 'concurrency-limited' ? '并发请求过多，请稍后再试' : '请求过于频繁，请稍后再试',
        );
      }
      bindAdmissionLease(admission.lease, req, res);
      securityAuditSpan?.annotate({ reasonCode: 'allowed' });
      AUTH_RUNTIME.touchActivity(authenticatedContext);

      if (routeAccess.stream) {
        requestAbortController = new AbortController();
        AUTH_STREAMS.register({
          sessionSelector: authenticatedContext.session.selector,
          deviceId: authenticatedContext.device.deviceId,
          expiresAt: authenticatedContext.session.expiresAt,
          request: req,
          response: res,
          controller: requestAbortController,
        });
      }
    }

    // A7：capability 自身是短期 bearer，因此读取路由在长期设备认证之前处理。
    // 这里只允许 manifest 已知且已经缓存的 assetId；任何失败都不会触网、写 manifest 或写 cache。
    const contentMatch = /^\/api\/assets\/content\/([a-f0-9]{24})$/.exec(p);
    if ((method === 'GET' || method === 'HEAD') && contentMatch) {
      if (!AUTH_RUNTIME) {
        req.resume();
        return dshJson(res, { error: '资产 capability 未启用', code: 'asset-capability-disabled', requestId }, 404);
      }
      const queryKeys = [...url.searchParams.keys()];
      const capability = url.searchParams.get('cap');
      if (queryKeys.length !== 1 || queryKeys[0] !== 'cap'
        || url.searchParams.getAll('cap').length !== 1 || !capability) {
        req.resume();
        return dshJson(res, { error: '资产 capability 无效', code: 'asset-capability-invalid', requestId }, 401);
      }
      const id = contentMatch[1];
      const manifest = loadManifest(ASSET_DIR);
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      const purpose = entry ? assetPurposeForUrl(entry.url) : null;
      const cache = new DiskCache(ASSET_DIR);
      const buf = entry && purpose ? cache.get(id) : null;
      if (!entry || !purpose || !buf) {
        req.resume();
        return dshJson(res, { error: '资产 capability 无效', code: 'asset-capability-invalid', requestId }, 401);
      }
      const rangeHeader = Array.isArray(req.headers.range) ? undefined : req.headers.range;
      const range = parseAssetRange(rangeHeader, buf.length);
      if (!range || (range.kind === 'partial' && purpose !== 'audio' && purpose !== 'video')) {
        req.resume();
        res.setHeader('Content-Range', `bytes */${buf.length}`);
        return dshJson(res, { error: 'Range 不可用', code: 'asset-range-invalid', requestId }, 416);
      }
      const consumed = AUTH_RUNTIME.consumeAssetCapability({
        token: capability,
        assetId: id,
        targetDigest: AuthRuntime.assetTargetDigest(entry.url),
        purpose,
        method,
        bytes: method === 'HEAD' ? 0 : range.length,
        rangeRequested: range.kind === 'partial',
        now: () => new Date().toISOString(),
      });
      if (!consumed.ok) {
        req.resume();
        return dshJson(res, { error: '资产 capability 无效', code: 'asset-capability-invalid', requestId }, 401);
      }
      securityAuditSpan?.annotate({
        reasonCode: 'asset-capability-allowed',
        sessionPublicId: consumed.sessionPublicId,
      });
      const headers: Record<string, string | number> = {
        'Content-Type': mimeForUrl(entry.url),
        'Content-Length': range.length,
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest, Range',
        ...(purpose === 'audio' || purpose === 'video' ? { 'Accept-Ranges': 'bytes' } : {}),
        ...(range.kind === 'partial'
          ? { 'Content-Range': `bytes ${range.start}-${range.end}/${buf.length}` }
          : {}),
      };
      if (shouldAllowOpaqueAssetCors({ method, pathname: p, headers: req.headers })) {
        headers['Access-Control-Allow-Origin'] = 'null';
      }
      res.writeHead(range.kind === 'partial' ? 206 : 200, headers);
      if (method === 'HEAD') res.end();
      else res.end(buf.subarray(range.start, range.end + 1));
      return;
    }

    // P8-05：短时下载 capability。格式是协议段，不是客户端文件名；任意失败统一为无效 token。
    const downloadMatch = /^\/api\/assets\/download\/([a-f0-9]{24})\/(json|png)$/.exec(p);
    if ((method === 'GET' || method === 'HEAD') && downloadMatch) {
      if (!AUTH_RUNTIME) {
        req.resume();
        return dshJson(res, { error: '资产下载 capability 未启用', code: 'asset-capability-disabled', requestId }, 404);
      }
      const queryKeys = [...url.searchParams.keys()];
      const capability = url.searchParams.get('cap');
      if (queryKeys.length !== 1 || queryKeys[0] !== 'cap'
        || url.searchParams.getAll('cap').length !== 1 || !capability) {
        req.resume();
        return dshJson(res, { error: '资产下载 capability 无效', code: 'asset-capability-invalid', requestId }, 401);
      }
      if (req.headers.range !== undefined) {
        req.resume();
        return dshJson(res, { error: '下载不支持 Range', code: 'asset-range-invalid', requestId }, 416);
      }
      const id = downloadMatch[1]!;
      const format = downloadMatch[2]! as AssetDownloadFormat;
      const identity = ASSET_IDENTITIES.getById(id);
      const prepared = identity ? prepareAssetDownload(identity, format) : null;
      if (!identity || !prepared) {
        req.resume();
        return dshJson(res, { error: '资产下载 capability 无效', code: 'asset-capability-invalid', requestId }, 401);
      }
      const consumed = AUTH_RUNTIME.consumeAssetCapability({
        token: capability,
        assetId: id,
        targetDigest: prepared.targetDigest,
        purpose: 'download',
        method,
        bytes: method === 'HEAD' ? 0 : prepared.body.length,
        rangeRequested: false,
        now: () => new Date().toISOString(),
      });
      if (!consumed.ok) {
        req.resume();
        return dshJson(res, { error: '资产下载 capability 无效', code: 'asset-capability-invalid', requestId }, 401);
      }
      securityAuditSpan?.annotate({
        reasonCode: 'asset-download-capability-allowed',
        sessionPublicId: consumed.sessionPublicId,
      });
      res.writeHead(200, {
        'Content-Type': prepared.mediaType,
        'Content-Length': prepared.body.length,
        'Content-Disposition': contentDisposition(identity.displayName, format),
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest',
      });
      if (method === 'HEAD') res.end();
      else res.end(prepared.body);
      return;
    }

    // -----------------------------------------------------------------
    // P5.2-A2-03：设备管理与吊销 handler。认证上下文只来自上面的中央门禁。
    // -----------------------------------------------------------------
    if (AUTH_RUNTIME && p.startsWith('/api/auth/')) {
      const context = authenticatedContext;

      // GET /api/auth/session —— 页面刷新后重新取得会话状态（cookie 模式附 CSRF token）。
      if (method === 'GET' && p === '/api/auth/session') {
        if (!context) return authGuardFailure(401, 'auth-required', '需要认证');
        const sessionRow = context.session;
        if (!sessionRow) return authGuardFailure(401, 'auth-invalid', '认证失败');
        const state: Record<string, unknown> = {
          device: {
            id: context.device.deviceId,
            displayName: context.device.displayName,
            platform: context.device.platform,
            scopes: [...context.device.scopes],
            createdAt: context.device.createdAt,
            ...(context.device.lastSeenAt ? { lastSeenAt: context.device.lastSeenAt } : {}),
          },
          session: {
            sessionId: sessionRow.publicId,
            deviceId: sessionRow.deviceId,
            transport: sessionRow.transport,
            scopes: [...context.device.scopes],
            issuedAt: sessionRow.issuedAt,
            expiresAt: sessionRow.expiresAt,
          },
        };
        if (sessionRow.transport === 'same-origin-cookie') {
          state.csrfToken = AUTH_RUNTIME.csrfTokenFor(sessionRow);
        }
        return json(res, state);
      }

      // POST /api/auth/logout —— 吊销当前会话；cookie 模式同步清 Cookie。
      if (method === 'POST' && p === '/api/auth/logout') {
        req.resume();
        if (context?.session && AUTH_RUNTIME.logoutSession(context.session.selector)) {
          AUTH_STREAMS.abortSession(context.session.selector);
        }
        if (context?.transport === 'same-origin-cookie') {
          res.setHeader(
            'Set-Cookie',
            `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
        }
        return json(res, { ok: true });
      }

      // POST /api/auth/pairing-codes —— admin 签发配对码；码只在本响应出现一次。
      if (method === 'POST' && p === '/api/auth/pairing-codes') {
        let body: Record<string, unknown>;
        try {
          body = await readLimitedBody(req, BODY_LIMITS.authPair, { deadlineMs: 10_000 });
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            return dshJson(res, { error: '请求体过大', code: 'payload-too-large', requestId }, 413);
          }
          return dshJson(res, { error: '请求体必须是合法 JSON', code: 'json-invalid', requestId }, 400);
        }
        if (!isIssuePairingCodeRequest(body)) {
          return dshJson(
            res,
            { error: '配对码签发请求形状不正确', code: 'pairing-code-request-invalid', requestId },
            400,
          );
        }
        const issued = AUTH_RUNTIME.issuePairingCode({
          scopes: body.allowedScopes,
          transports: body.allowedTransports,
          displayNameHint: body.displayNameHint ?? 'admin-issued',
          ttlSeconds: body.ttlSeconds,
          now: () => new Date().toISOString(),
        });
        // 明文只出现在本响应；no-store 防止任何缓存留存。
        return json(res, {
          id: issued.selector,
          state: 'active',
          code: issued.code,
          expiresAt: issued.expiresAt,
          attemptsRemaining: issued.attemptsRemaining,
        });
      }

      // GET /api/auth/devices —— admin 设备列表（公开投影，无 selector/摘要）。
      if (method === 'GET' && p === '/api/auth/devices') {
        const devices = AUTH_RUNTIME.listDevices().map((device) => ({
          id: device.deviceId,
          displayName: device.displayName,
          platform: device.platform,
          scopes: [...device.scopes],
          createdAt: device.createdAt,
          ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
          ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
        }));
        return json(res, { devices });
      }

      // POST /api/auth/devices/:deviceId/revoke —— 级联吊销该设备全部会话。
      const revokeRoute = matchRouteTemplate('/api/auth/devices/:deviceId/revoke', p);
      if (method === 'POST' && revokeRoute) {
        req.resume();
        const targetId = revokeRoute.deviceId;
        const result = AUTH_RUNTIME.revokeDeviceWithSessions(targetId);
        if (!result.revoked) {
          return dshJson(res, { error: '设备不存在或已吊销', code: 'device-not-found', requestId }, 404);
        }
        AUTH_STREAMS.abortDevice(targetId);
        return json(res, {
          deviceId: targetId,
          revokedAt: new Date().toISOString(),
          revokedSessions: result.sessions,
        });
      }

      // POST /api/auth/revoke-all —— 全部吊销 + security epoch +1（缓存中的旧上下文一并失效）。
      if (method === 'POST' && p === '/api/auth/revoke-all') {
        let body: Record<string, unknown>;
        try {
          body = await readLimitedBody(req, BODY_LIMITS.authPair, { deadlineMs: 10_000 });
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            return dshJson(res, { error: '请求体过大', code: 'payload-too-large', requestId }, 413);
          }
          return dshJson(res, { error: '请求体必须是合法 JSON', code: 'json-invalid', requestId }, 400);
        }
        const keepCurrent = body.keepCurrent === undefined ? true : body.keepCurrent === true;
        const result = AUTH_RUNTIME.revokeAllForReset({
          at: new Date().toISOString(),
          keepDeviceId: keepCurrent && context ? context.device.deviceId : null,
        });
        AUTH_STREAMS.abortAll();
        // 当前会话也随全表吊销失效（保留的只是设备记录，会话需重新认证/配对）。
        if (context?.transport === 'same-origin-cookie') {
          res.setHeader(
            'Set-Cookie',
            `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
        }
        return json(res, {
          securityEpoch: result.securityEpoch,
          revokedDevices: result.devices,
          revokedSessions: result.sessions,
          revokedPairings: result.pairings,
        });
      }
    }

    // DSH 公开面只能位于 /ext/<pluginId>/...，无法遮蔽 /api。
    if (p.startsWith('/ext/')) {
      if (!admitDshBody(req, res)) return;
      if (dshHost.count() > 0 && await dshHost.dispatch(req, res, p)) return;
    }

    // 角色卡列表
    if (method === 'GET' && p === '/api/assets/local') {
      const cards = listCards();
      const presets = listAssets('preset');
      const worldbooks = listAssets('worldbook');
      ASSET_IDENTITIES.ensureDiscovered([
        ...cards.map((asset) => ({ kind: 'card' as const, storageKey: asset.file, displayName: asset.name })),
        ...presets.map((asset) => ({ kind: 'preset' as const, storageKey: asset.file, displayName: asset.name })),
        ...worldbooks.map((asset) => ({ kind: 'worldbook' as const, storageKey: asset.file, displayName: asset.name })),
      ]);
      const assets: LocalAssetDescriptor[] = [];
      for (const card of cards) {
        try {
          const revision = readRevisionedCard(card.file)?.revision;
          const identity = ASSET_IDENTITIES.findByStorageKey('card', card.file);
          if (revision && identity) assets.push({
            assetId: identity.assetId,
            kind: 'card',
            displayName: identity.displayName,
            source: card.source,
            revision,
          });
        } catch { /* 单个损坏资产不污染目录 */ }
      }
      for (const [kind, listed] of [
        ['preset', presets],
        ['worldbook', worldbooks],
      ] as const) {
        for (const asset of listed) {
          try {
            const revision = readRevisionedAsset(kind, asset.file)?.revision;
            const identity = ASSET_IDENTITIES.findByStorageKey(kind, asset.file);
            if (revision && identity) assets.push({
              assetId: identity.assetId,
              kind,
              displayName: identity.displayName,
              source: asset.source,
              revision,
            });
          } catch { /* 单个损坏资产不污染目录 */ }
        }
      }
      assets.sort((a, b) => `${a.kind}\0${a.assetId}`.localeCompare(`${b.kind}\0${b.assetId}`));
      return json(res, { assets });
    }

    // 角色卡兼容列表：id/name 为旧客户端字段；assetId 是所有新写入的权威引用。
    if (method === 'GET' && p === '/api/cards') {
      const listedCards = listCards();
      ASSET_IDENTITIES.ensureDiscovered(listedCards.map((card) => ({
        kind: 'card',
        storageKey: card.file,
        displayName: card.name,
      })));
      const cards = listedCards.flatMap((c) => {
        try {
          const card = readRevisionedCard(c.file);
          if (!card) return [];
          const identity = ensureAssetIdentity('card', c.file);
          return [{
            id: c.file,
            assetId: identity.assetId,
            name: identity.displayName,
            format: c.format,
            source: c.source,
            revision: card.revision,
          }];
        } catch { return []; }
      });
      return json(res, { cards });
    }

    // 会话列表（data/*.db：卡名标题 + 最新消息预览 + 轮次）
    if (method === 'GET' && p === '/api/sessions') {
      if (!existsSync(DATA_DIR)) return json(res, { sessions: [] });
      const dbs = readdirSync(DATA_DIR).filter((f) => f.endsWith('.db'));
      const list = dbs.map((f) => {
        const dbPath = resolve(DATA_DIR, f);
        const meta = readSessionMeta(dbPath);
        const id = f.replace(/\.db$/, '');
        return {
          id,
          file: f,
          name: meta.card || id,
          preview: meta.preview,
          round: meta.round,
          start: meta.start,
          createdAt: meta.createdAt,
          revision: meta.revision,
          snapshotToken: meta.snapshotToken,
        };
      });
      return json(res, { sessions: list });
    }

    // ── 前端日志落盘（浏览器上报 → data/web.log 逐行追加；前端已脱敏，后端再兜底 strip）──
    if (method === 'POST' && p === '/api/log') {
      if (AUTH_RUNTIME) {
        req.resume();
        securityAuditSpan?.annotate({ reasonCode: 'client-log-discarded' });
        res.statusCode = 204;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }
      const body = await readBody(req);
      const entries = Array.isArray((body as { entries?: unknown }).entries)
        ? (body as { entries: unknown[] }).entries
        : [body];
      const lines = entries
        .filter((e) => e && typeof e === 'object')
        .map((e) => JSON.stringify({
          ts: (e as { ts?: unknown }).ts ?? '',
          level: (e as { level?: unknown }).level ?? 'info',
          scope: (e as { scope?: unknown }).scope ?? '',
          msg: String((e as { msg?: unknown }).msg ?? ''),
          data: stripSensitive((e as { data?: unknown }).data),
        }));
      if (lines.length > 0) appendFileSync(WEB_LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
      return json(res, { ok: true, count: lines.length });
    }

    // ── 插件市场（04 §4.1 / §7：git 安装 + 启停 + 卸载 + 更新）──
    if (method === 'GET' && p === '/api/plugins') {
      const activeIds = new Set(dshHost.ids());
      return json(res, {
        plugins: pluginRegistry.list().map((plugin) => {
          const publicPlugin = toPublicPluginRecord(plugin);
          if (plugin.kind !== 'dsh') return publicPlugin;
          const runtimeStatus = !plugin.enabled
            ? 'disabled'
            : activeIds.has(plugin.id) ? 'active' : 'failed';
          return {
            ...publicPlugin,
            runtimeStatus,
            ...(runtimeStatus === 'failed' ? {
              runtimeError: '插件已启用但运行实例未激活',
            } : {}),
          };
        }),
      });
    }

    // P8-08：同步冻结当前 Node 写回调并用在线 SQLite 副本生成本机私有一致快照。
    // 远端只得到公开摘要，绝不返回 dataDir、component 路径或 provider 配置内容。
    if (method === 'POST' && p === '/api/snapshots') {
      const body = await readBody(req);
      if (Object.keys(body).length !== 0) {
        return json(res, { error: '快照创建请求不接受参数', code: 'invalid-snapshot-request' }, 400);
      }
      const inventory = buildDefaultSnapshotInventory(DATA_DIR);
      const result = SNAPSHOT_COORDINATOR.create({
        applicationVersion: APP_VERSION,
        components: inventory.components,
        plugins: inventory.plugins,
      });
      return json(res, {
        snapshot: {
          snapshotId: result.manifest.snapshotId,
          createdAt: result.manifest.createdAt,
          componentCount: result.manifest.components.length,
          pluginCount: result.manifest.plugins.length,
        },
      }, 201);
    }
    if (method === 'POST' && p === '/api/plugins/install') {
      const body = await readBody(req);
      const url = String(body.url ?? '').trim();
      if (!url) return json(res, { error: '缺少插件来源（git URL / 本地路径 / .zip）' }, 400);
      return await runPluginMutation(async () => {
        let installed: ReturnType<PluginRegistry['get']>;
        try {
          const rec = await pluginRegistry.install(url);
          if (rec.kind === 'dsh') {
            try {
              await reloadDshPlugin(rec.id);
            } catch (error) {
              pluginRegistry.setEnabled(rec.id, false);
              await reloadDshPlugin(rec.id);
              throw new Error(`插件已安装但激活失败，已自动禁用：${(error as Error).message}`);
            }
          }
          installed = rec;
        } catch (e) {
          return pluginAdminError(
            res, requestId, 400, 'plugin-install-failed',
            '插件安装失败；详情见电脑端日志', e,
          );
        }
        return json(res, { plugin: toPublicPluginRecord(installed!) });
      });
    }
    const pluginsActionPostRoute = matchRouteTemplate('/api/plugins/:id/:action', p);
    if (method === 'POST' && pluginsActionPostRoute) {
      const id = pluginsActionPostRoute.id;
      const action = pluginsActionPostRoute.action;
      if (action === 'enable' || action === 'disable') {
        return await runPluginMutation(async () => {
          const previous = pluginRegistry.get(id);
          const previousEnabled = previous?.enabled;
          const previousKind = previous?.kind;
          let changed: ReturnType<PluginRegistry['get']>;
          try {
            const rec = pluginRegistry.setEnabled(id, action === 'enable');
            if (rec.kind === 'dsh') await reloadDshPlugin(id);
            changed = rec;
          }
          catch (e) {
            if (previousEnabled !== undefined) {
              pluginRegistry.setEnabled(id, previousEnabled);
              if (previousKind === 'dsh') {
                try {
                  await reloadDshPlugin(id);
                } catch {
                  pluginRegistry.setEnabled(id, false);
                  await reloadDshPlugin(id);
                }
              }
            }
            return pluginAdminError(
              res, requestId, 400, 'plugin-state-change-failed',
              '插件启用/停用失败；详情见电脑端日志', e,
            );
          }
          return json(res, { plugin: toPublicPluginRecord(changed!) });
        });
      }
      if (action === 'uninstall') {
        return await runPluginMutation(async () => {
          try {
            await dshHost.unload(id);
            pluginRegistry.uninstall(id);
            dshRuntimeErrors.delete(id);
          }
          catch (e) {
            let restoreError = '';
            try {
              await reloadDshPlugin(id);
            } catch (error) {
              restoreError = `；旧运行态恢复失败：${(error as Error).message}`;
            }
            return pluginAdminError(
              res, requestId, restoreError ? 500 : 400, 'plugin-uninstall-failed',
              restoreError
                ? '插件卸载未生效，且旧运行态恢复失败；详情见电脑端日志'
                : '插件卸载未生效；详情见电脑端日志',
              `${(e as Error).message}${restoreError}`,
            );
          }
          return json(res, { ok: true });
        });
      }
      if (action === 'update') {
        return await runPluginMutation(async () => {
          let transaction: PluginUpdateTransaction | undefined;
          let committedRecord: PluginUpdateTransaction['record'] | undefined;
          try {
            // prepare 保留旧目录 backup；新版本运行态验证成功并提交 registry 后才 finalize。
            transaction = await pluginRegistry.prepareUpdate(id);
            await dshHost.unload(id); // DSH→ST 也必须撤掉旧 owner
            const rec = transaction.record;
            if (rec.enabled && rec.kind === 'dsh') {
              await dshHost.load(rec, resolve(PLUGINS_DIR, rec.name));
            }
            transaction.commit();
            committedRecord = rec;
          }
          catch (e) {
            if (!transaction) {
              return pluginAdminError(
                res, requestId, 400, 'plugin-update-failed',
                '插件更新失败；详情见电脑端日志', e,
              );
            }
            try { await dshHost.unload(id); } catch { /* 回滚目录优先，运行态错误随后显式记录 */ }
            try {
              transaction.rollback();
            } catch (rollbackError) {
              dshRuntimeErrors.set(
                id,
                `更新恢复需要人工处理：${(rollbackError as Error).message}`.slice(0, 160),
              );
              return pluginAdminError(
                res, requestId, 500, 'plugin-update-rollback-failed',
                '插件更新失败，且旧版本目录回滚失败，需要人工处理；详情见电脑端日志',
                (rollbackError as Error).message,
              );
            }
            const previous = transaction.previous;
            let restoreError = '';
            if (previous.enabled && previous.kind === 'dsh') {
              try {
                await reloadDshPlugin(id);
              } catch (error) {
                restoreError = `；旧版本运行态恢复失败：${(error as Error).message}`;
              }
            } else {
              dshRuntimeErrors.delete(id);
            }
            return pluginAdminError(
              res, requestId, restoreError ? 500 : 400, 'plugin-update-failed',
              restoreError
                ? '插件更新未生效，已回滚旧版本，但旧版本运行态恢复失败；详情见电脑端日志'
                : '插件更新未生效，已回滚旧版本；详情见电脑端日志',
              `${(e as Error).message}${restoreError}`,
            );
          }
          // commit 之后的响应错误不能再进入回滚路径，否则会卸载已发布的新版本。
          dshRuntimeErrors.delete(id);
          return json(res, { plugin: toPublicPluginRecord(committedRecord!) });
        });
      }
    }

    // 新会话（SSE：阶段进度；启动流程审查 P0：入参收纳 世界书/预设/预设块勾选）
    if (method === 'POST' && p === '/api/session/new') {
      const body = await readBody(req);
      const cardFile = readAssetReference('card', body.card);
      if (!cardFile) {
        return json(res, { error: '角色卡不存在或 assetId 非法' }, 404);
      }
      const cardRes = resolveCard(cardFile);
      if (!cardRes) return json(res, { error: '角色卡不存在或 assetId 非法' }, 404);
      ensureAssetIdentity('card', cardFile);
      const worldbooks: string[] = [];
      for (const reference of Array.isArray(body.worldbooks) ? body.worldbooks : []) {
        const file = readAssetReference('worldbook', reference);
        if (!file || !readRevisionedAsset('worldbook', file)) {
          return json(res, { error: '世界书不存在或 assetId 非法' }, 404);
        }
        ensureAssetIdentity('worldbook', file);
        worldbooks.push(file);
      }
      const preset = body.preset ? readAssetReference('preset', body.preset) : null;
      if (body.preset && (!preset || !readRevisionedAsset('preset', preset))) {
        return json(res, { error: '预设不存在或 assetId 非法' }, 404);
      }
      if (preset) ensureAssetIdentity('preset', preset);
      // 卡片导入会话（PNG 卡由 ChatSession 内部解包，见 tools/cli/session.ts init）
      sse(res);
      try {
        const dbName = `session-${Date.now()}.db`;
        const dbPath = resolve(DATA_DIR, dbName);
        const mode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
        let presetOverrides: Record<string, boolean> | undefined;
        if (body.preset_overrides && typeof body.preset_overrides === 'object') {
          presetOverrides = body.preset_overrides as Record<string, boolean>;
        }
        const session = new ChatSession({
          card: cardRes.path, db: dbPath, resume: false, useBge: false, contentMode: mode,
          worldbooks: worldbooks.length > 0 ? worldbooks : undefined,
          preset: preset ?? undefined,
          presetOverrides,
          style: typeof body.style === 'string' && body.style ? body.style : undefined,
          providerClient: providerClientForServer(),
          observeProviderClient: observeServerModelClient,
          learnedStyleResolver: learnedStyleResolverForSession(dbName.replace(/\.db$/, '')),
          interactiveHarness: interactiveHarnessForSession(dbName.replace(/\.db$/, '')),
          agentAdmission: agentAdmissionForSession(dbName.replace(/\.db$/, '')),
          quietLogs: ACCESS_MODE === 'secured',
        });
        await session.init((stage) => sseSend(res, { type: 'stage', stage }), requestAbortController?.signal);
        try { hydrateLearningFromLedger(session); } catch { /* 本地空/可重建投影继续，不阻断建档 */ }
        const id = dbName.replace(/\.db$/, '');
        sessions.set(id, session);
        scheduleLearningDrain(session);
        const snapshot = snapshotForSession(session);
        // DSH 插件会话事件：session/created（对齐官方 core/session Events）
        dshHost.emitSessionCreated({ id, card: session.getCardName(), round: 0 });
        eventHub.publish({
          type: 'session.created',
          resource: { kind: 'session', id, revision: snapshot.snapshotToken },
          requestId,
        });
        sseSend(res, {
          type: 'ready',
          id,
          greeting: session.getGreeting(),
          card: session.getCardName(),
          db: dbName,
          contentMode: mode,
          config: session.getSessionConfig(),
          revision: snapshot.snapshotToken,
          snapshotToken: snapshot.snapshotToken,
        });
        res.end();
        setTimeout(() => void session.warmRetrievalChannels(
          ACCESS_MODE === 'secured' ? undefined : (stage) => console.log(`[session/new:${id}] warm ${stage}`),
        ), 0);
      } catch (e) {
        // SSE 已发头：错误必须走事件通道如实上报，不能回退成 JSON（会破坏流/丢错误）
        const msg = (e as Error)?.message ?? String(e);
        console.error(`[web-api] 会话创建失败 requestId=${requestId} detail=redacted`);
        try { sseSend(res, { type: 'error', message: msg.slice(0, 500) }); } catch { /* 连接已断 */ }
        try { res.end(); } catch { /* ignore */ }
      }
      return;
    }

    // 恢复会话
    if (method === 'POST' && p === '/api/session/resume') {
      const body = await readBody(req);
      const dbName = String(body.db ?? '');
      const dbPath = resolveSessionDatabase(DATA_DIR, dbName);
      if (!dbPath) return json(res, { error: '会话文件名无效' }, 400);
      if (!existsSync(dbPath)) return json(res, { error: '会话不存在' }, 404);
      const id = dbName.replace(/\.db$/, '');
      const session = await loadSessionById(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const snapshot = snapshotForSession(session);
      return revisionJson(res, { id, snapshotToken: snapshot.snapshotToken }, snapshot.snapshotToken);
    }

    // P7：服务端持久生成任务。POST 创建后立即由唯一 runner 执行；GET 是真值，
    // cancel 是唯一可以中止上游的 HTTP 入口。originDeviceId 只取认证上下文。
    if (method === 'POST' && p === '/api/turn-jobs') {
      if (!releaseAdmissionOpen()) {
        req.resume();
        res.setHeader('Retry-After', '5');
        return json(res, { error: '主机版本切换正在收口，请稍后重试', code: 'release-draining' }, 503);
      }
      const rawIdempotency = req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
      const idempotencyKey = typeof rawIdempotency === 'string' ? rawIdempotency : '';
      if (!isSafeOpaqueId(idempotencyKey, 200) || idempotencyKey.length < 8) {
        req.resume();
        return json(res, { error: 'Idempotency-Key 缺失或非法', code: 'idempotency-key-invalid' }, 400);
      }
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) throw error;
        return json(res, { error: '请求体必须是合法 JSON', code: 'json-invalid' }, 400);
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const action = body.action;
      if (!isSafeOpaqueId(sessionId) || (action !== 'turn' && action !== 'regenerate')) {
        return json(res, { error: 'turn job 请求形状非法', code: 'turn-job-request-invalid' }, 400);
      }
      const session = sessions.get(sessionId);
      if (!session) return json(res, { error: '会话不存在，请先创建或恢复', code: 'session-not-found' }, 404);
      let round: number;
      let input: string | undefined;
      let attachments: ImageAttachment[] | undefined;
      let branchSelection: BranchSelectionReference | undefined;
      const contentMode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
      if (action === 'turn') {
        input = String(body.input ?? '').trim();
        try {
          attachments = parseImageAttachments(body.attachments);
          branchSelection = parseBranchSelection(body.branchSelection);
        } catch (error) {
          return json(res, { error: (error as Error).message.slice(0, 200), code: 'attachments-invalid' }, 400);
        }
        if (!input && attachments.length === 0) {
          return json(res, { error: '输入为空', code: 'turn-input-empty' }, 400);
        }
        round = session.getMemory().round + 1;
      } else {
        round = Number(body.round ?? 0);
        if (!Number.isInteger(round) || round < 1) {
          return json(res, { error: 'round 非法', code: 'round-invalid' }, 400);
        }
      }
      try {
        const created = turnJobs.create({
          sessionId,
          action,
          requestId,
          originDeviceId: authenticatedContext?.device.deviceId ?? 'local-device',
          idempotencyKey,
          round,
          ...(input === undefined ? {} : { input }),
          ...(attachments === undefined ? {} : { attachments }),
          ...(branchSelection === undefined ? {} : { branchSelection }),
          ...(action === 'turn' ? { contentMode } : {}),
        });
        return json(res, created, created.job.status === 'queued' || created.job.status === 'running' ? 202 : 200);
      } catch (error) {
        if (error instanceof TurnJobAdmissionError) {
          res.setHeader('Retry-After', '5');
          return json(res, { error: error.message, code: error.code }, 503);
        }
        if (error instanceof TurnJobConflictError) {
          return json(res, {
            error: error.message,
            code: error.code,
            ...(error.runId ? { runId: error.runId } : {}),
          }, 409);
        }
        return json(res, { error: (error as Error).message.slice(0, 200), code: 'turn-job-create-failed' }, 400);
      }
    }

    const turnJobCancelRoute = matchRouteTemplate('/api/turn-jobs/:runId/cancel', p);
    if (method === 'POST' && turnJobCancelRoute) {
      const runId = turnJobCancelRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      try {
        await readBody(req);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) throw error;
        return json(res, { error: '请求体必须是合法 JSON', code: 'json-invalid' }, 400);
      }
      try {
        const existing = turnJobs.get(runId);
        if (!existing) return json(res, { error: 'turn job 不存在', code: 'turn-job-not-found' }, 404);
        return json(res, { job: turnJobs.cancel(runId) });
      } catch (error) {
        if (error instanceof TurnJobConflictError) {
          return json(res, { error: error.message, code: error.code, runId }, 409);
        }
        return json(res, { error: '取消生成任务失败', code: 'turn-job-cancel-failed' }, 400);
      }
    }

    const turnJobGetRoute = matchRouteTemplate('/api/turn-jobs/:runId', p);
    if (method === 'GET' && turnJobGetRoute) {
      const runId = turnJobGetRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      const job = turnJobs.get(runId);
      return job
        ? json(res, { job })
        : json(res, { error: 'turn job 不存在', code: 'turn-job-not-found' }, 404);
    }

    // P13-B：后台 lane 仅暴露公开 DTO、计数/diff 与稳定错误码；不返回 prompt、
    // 工具正文、Provider 响应或租约。生产首发由环境变量硬限制为 shadow。
    if (method === 'GET' && p === '/api/maintenance') {
      return json(res, {
        runtime: { lane: MAINTENANCE_RUNTIME.lane, enabled: MAINTENANCE_RUNTIME.enabled },
        globalEnabled: maintenanceJobs.globalEnabled(),
        policyVersion: MAINTENANCE_POLICY_VERSION,
        policy: MAINTENANCE_POLICY,
      });
    }

    if (method === 'POST' && p === '/api/maintenance/control') {
      const body = await readBody(req);
      if (Object.keys(body).some((key) => key !== 'globalEnabled')
        || typeof body.globalEnabled !== 'boolean') {
        return json(res, { error: 'maintenance control 请求非法', code: 'maintenance-control-invalid' }, 400);
      }
      if (body.globalEnabled && !MAINTENANCE_RUNTIME.enabled) {
        return json(res, { error: '后台 Harness 未由宿主显式启用', code: 'maintenance-runtime-disabled' }, 409);
      }
      maintenanceHarness!.setGlobalEnabled(body.globalEnabled);
      if (body.globalEnabled) queueMicrotask(() => { void maintenanceHarness?.drainAvailable(4); });
      return json(res, { ok: true, globalEnabled: maintenanceJobs.globalEnabled() });
    }

    const maintenanceJobCancelRoute = matchRouteTemplate('/api/maintenance-jobs/:runId/cancel', p);
    if (method === 'POST' && maintenanceJobCancelRoute) {
      const runId = maintenanceJobCancelRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      await readBody(req);
      const existing = maintenanceHarness!.get(runId);
      if (!existing) return json(res, { error: 'maintenance job 不存在', code: 'maintenance-job-not-found' }, 404);
      return json(res, { job: maintenanceHarness!.cancel(runId) });
    }

    const maintenanceJobGetRoute = matchRouteTemplate('/api/maintenance-jobs/:runId', p);
    if (method === 'GET' && maintenanceJobGetRoute) {
      const runId = maintenanceJobGetRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      const job = maintenanceHarness!.get(runId);
      return job
        ? json(res, { job })
        : json(res, { error: 'maintenance job 不存在', code: 'maintenance-job-not-found' }, 404);
    }

    const maintenanceSessionRoute = matchRouteTemplate('/api/session/:sessionId/maintenance', p);
    if (method === 'GET' && maintenanceSessionRoute) {
      const sessionId = maintenanceSessionRoute.sessionId;
      if (!isSafeOpaqueId(sessionId)) return json(res, { error: 'sessionId 非法', code: 'session-id-invalid' }, 400);
      return json(res, {
        settings: maintenanceHarness!.settings(sessionId),
        jobs: maintenanceHarness!.list(sessionId),
      });
    }

    const maintenanceSettingsRoute = matchRouteTemplate('/api/session/:sessionId/maintenance/settings', p);
    if (method === 'POST' && maintenanceSettingsRoute) {
      const sessionId = maintenanceSettingsRoute.sessionId;
      if (!isSafeOpaqueId(sessionId)) return json(res, { error: 'sessionId 非法', code: 'session-id-invalid' }, 400);
      const body = await readBody(req);
      if (Object.keys(body).some((key) => key !== 'enabled') || typeof body.enabled !== 'boolean') {
        return json(res, { error: 'maintenance settings 请求非法', code: 'maintenance-settings-invalid' }, 400);
      }
      if (!await loadSessionById(sessionId)) {
        return json(res, { error: '会话不存在', code: 'session-not-found' }, 404);
      }
      maintenanceHarness!.setSessionEnabled(sessionId, body.enabled);
      return json(res, { settings: maintenanceHarness!.settings(sessionId) });
    }

    const maintenanceCreateRoute = matchRouteTemplate('/api/session/:sessionId/maintenance-jobs', p);
    if (method === 'POST' && maintenanceCreateRoute) {
      const sessionId = maintenanceCreateRoute.sessionId;
      if (!isSafeOpaqueId(sessionId)) return json(res, { error: 'sessionId 非法', code: 'session-id-invalid' }, 400);
      const body = await readBody(req);
      if (Object.keys(body).some((key) => key !== 'taskKind') || !isMaintenanceTaskKind(body.taskKind)) {
        return json(res, { error: 'maintenance job 请求非法', code: 'maintenance-job-request-invalid' }, 400);
      }
      if (!MAINTENANCE_RUNTIME.enabled) {
        return json(res, { error: '后台 Harness 未由宿主显式启用', code: 'maintenance-runtime-disabled' }, 409);
      }
      const session = await loadSessionById(sessionId);
      if (!session) return json(res, { error: '会话不存在', code: 'session-not-found' }, 404);
      // Q8 production Provider must be backed by a persisted post-turn admission batch.
      // The legacy manual endpoint remains discoverable but cannot manufacture an unaudited job.
      return json(res, {
        error: '手动后台任务需要由已提交回合的准入决策触发',
        code: 'maintenance-admission-required',
      }, 409);
    }

    // -----------------------------------------------------------------
    // P7-05/06：失效通知 SSE。中央管线已完成认证/scope/Origin/连接预算；
    // routeAccess.stream=true 已把连接登记进 AUTH_STREAMS（吊销即终止）。
    // 事件只触发 refetch：有界 replay（P7-06）只补最近缓冲内的连续区间，
    // 任何缺口/跨实例/超前游标都回 sync.required；REST/SQLite 仍是唯一真值。
    // -----------------------------------------------------------------
    if (method === 'GET' && p === '/api/events') {
      const rawCursor = req.headers['last-event-id'];
      const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
      const cursorInstanceHeader = req.headers['x-jg-last-server-instance'];
      const cursorInstance = Array.isArray(cursorInstanceHeader)
        ? cursorInstanceHeader[0]
        : cursorInstanceHeader;
      sse(res);
      res.write('retry: 5000\n\n');
      if (typeof cursor === 'string' && cursor.length > 0) {
        const replay = eventHub.replayFrom(cursor, cursorInstance);
        if (replay.kind === 'replay') {
          securityAuditSpan?.annotate({ reasonCode: 'events-replay' });
          for (const envelope of replay.envelopes) {
            res.write(
              `id: ${envelope.eventId}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
            );
          }
        } else {
          securityAuditSpan?.annotate({ reasonCode: `events-sync-${replay.reason}` });
          const sync = eventHub.syncEnvelope();
          res.write(
            `id: ${sync.eventId}\nevent: sync.required\ndata: ${JSON.stringify(sync)}\n\n`,
          );
        }
      } else {
        securityAuditSpan?.annotate({ reasonCode: 'events-fresh' });
      }
      res.write(`: connected serverInstanceId=${SERVER_INSTANCE_ID} replay=bounded\n\n`);
      let closed = false;
      const unsubscribe = eventHub.subscribe((envelope: EventEnvelope) => {
        if (closed || res.writableEnded || res.destroyed) return;
        try {
          res.write(
            `id: ${envelope.eventId}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
          );
        } catch { /* 客户端已断开；close 回调负责清理。 */ }
      });
      const heartbeat = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) return;
        try { res.write(': hb\n\n'); } catch { /* ignore */ }
      }, 20_000);
      heartbeat.unref?.();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      res.once('close', cleanup);
      res.once('finish', cleanup);
      return;
    }

    // 旧 SSE 兼容入口：连接只订阅服务端 job；req close 不再中止上游。
    if (method === 'POST' && p === '/api/turn') {
      // Install disconnect listeners before reading the body. Otherwise an immediate
      // Stop can close the request before the old late listener exists.
      const ac = requestAbortController ?? new AbortController();
      const centrallyManaged = requestAbortController !== null;
      const onRequestAborted = () => ac.abort();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      const cleanupConnection = () => {
        if (centrallyManaged) return;
        req.off('aborted', onRequestAborted);
        res.off('close', onClose);
        res.off('finish', cleanupConnection);
      };
      if (!centrallyManaged) {
        req.once('aborted', onRequestAborted);
        res.once('close', onClose);
        res.once('finish', cleanupConnection);
      }
      const body = await readBody(req);
      if (ac.signal.aborted || req.aborted || res.destroyed) return;
      const sessionId = String(body.session ?? '');
      const session = sessions.get(sessionId);
      if (!session) return json(res, { error: '会话不存在，请先创建或恢复' }, 404);
      const input = String(body.input ?? '').trim();
      let attachments: ImageAttachment[];
      let branchSelection: BranchSelectionReference | undefined;
      try {
        attachments = parseImageAttachments(body.attachments);
        branchSelection = parseBranchSelection(body.branchSelection);
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
      if (!input && attachments.length === 0) return json(res, { error: '输入为空' }, 400);
      const compatibilityRunId = body.runId === undefined
        ? `legacy-${requestId}`
        : (isSafeOpaqueId(body.runId) ? body.runId : undefined);
      if (!compatibilityRunId) return json(res, { error: 'runId 非法' }, 400);
      const mode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
      let created: ReturnType<TurnJobService['create']>;
      try {
        created = turnJobs.create({
          sessionId,
          action: 'turn',
          requestId,
          originDeviceId: authenticatedContext?.device.deviceId ?? 'local-device',
          idempotencyKey: compatibilityRunId,
          compatibilityRunId,
          round: session.getMemory().round + 1,
          input: input || '请观察并回应这张图片。',
          contentMode: mode,
          attachments,
          ...(branchSelection ? { branchSelection } : {}),
        });
      } catch (error) {
        sse(res);
        const message = error instanceof TurnJobConflictError && error.code === 'session-turn-active'
          ? '上一回合仍在生成中，请先停止或等待完成'
          : (error as Error).message.slice(0, 200);
        sseSend(res, { type: 'error', message });
        res.end();
        return;
      }

      sse(res);
      const stopHeartbeat = startTurnSseHeartbeat(res);
      let streamStarted = false;
      const unsubscribe = turnJobs.subscribe(created.job.runId, (chunk) => {
        if (!streamStarted) {
          sseSend(res, { type: 'status', stage: 'streaming', runId: created.job.runId, round: created.job.round });
          streamStarted = true;
        }
        sseSend(res, { type: 'delta', text: chunk });
      });
      sseSend(res, {
        type: 'status',
        stage: created.job.status === 'queued' ? 'queued' : 'thinking',
        runId: created.job.runId,
        round: created.job.round,
        startedAt: Date.parse(created.job.startedAt ?? created.job.createdAt),
      });
      try {
        const settled = await turnJobs.wait(created.job.runId, ac.signal);
        const value = settled.value ?? turnJobs.valueFromCommittedJob(settled.job);
        if (settled.job.status === 'succeeded' && value?.action === 'turn') {
          if (!streamStarted) sseSend(res, { type: 'status', stage: 'streaming', runId: settled.job.runId });
          sseSend(res, { type: 'done', prose: value.prose, aborted: false, runId: settled.job.runId });
          const stateConn = session.lastTurnStateConnection();
          if (stateConn) {
            sseSend(res, {
              type: 'state', committed: stateConn.committed, messageId: stateConn.messageId,
              source: stateConn.source ?? null, stateVersion: stateConn.stateVersion ?? null, note: stateConn.note,
            });
          }
          const charNotices = session.drainCharacterNotices();
          sseSend(res, {
            type: 'memory', committed: charNotices.length > 0,
            characters: charNotices, headVersion: session.memoryHeadVersion(),
            pending: session.getCharacterPending(), pool: session.getCharacterPool(),
          });
        } else if (settled.job.status === 'cancelled') {
          sseSend(res, { type: 'done', prose: '', aborted: true, runId: settled.job.runId });
        } else if (settled.job.status === 'failed') {
          sseSend(res, {
            type: 'error',
            message: turnJobFailureMessage('turn', settled.job.error?.code),
            code: settled.job.error?.code,
          });
        }
      } catch (error) {
        // subscriber AbortError 只结束本连接；runner/job 的 AbortSignal 不受影响。
        if ((error as Error).name !== 'AbortError') {
          sseSend(res, { type: 'error', message: '生成任务状态读取失败' });
        }
      } finally {
        unsubscribe();
        stopHeartbeat();
      }
      cleanupConnection();
      res.end();
      return;
    }

    // 静默生成（ST 生态前端 generateQuietPrompt → rpc ai.generate 的宿主端点）
    // 非 SSE（client.complete 一次性）：复用会话真实窗口+卡设定补全，不落 chat_log/不改记忆
    const quietPostRoute = matchRouteTemplate('/api/session/:sessionId/quiet', p);
    if (method === 'POST' && quietPostRoute) {
      if (!releaseAdmissionOpen()) {
        req.resume();
        res.setHeader('Retry-After', '5');
        return json(res, { error: '主机版本切换正在收口，请稍后重试', code: 'release-draining' }, 503);
      }
      const id = quietPostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) return json(res, { error: '生成提示为空' }, 400);
      try {
        const round = Number(body.round) || 0;
        const mode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
        const text = await session.quietGenerate(prompt, { round, mode: mode as 'nsfw' | 'nsf' });
        return json(res, { text });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    // 重新生成兼容入口：与 /api/turn 共用同一持久 manager/runner。
    const regeneratePostRoute = matchRouteTemplate('/api/session/:sessionId/regenerate', p);
    if (method === 'POST' && regeneratePostRoute) {
      const ac = requestAbortController ?? new AbortController();
      const centrallyManaged = requestAbortController !== null;
      const onRequestAborted = () => ac.abort();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      const cleanupConnection = () => {
        if (centrallyManaged) return;
        req.off('aborted', onRequestAborted);
        res.off('close', onClose);
        res.off('finish', cleanupConnection);
      };
      if (!centrallyManaged) {
        req.once('aborted', onRequestAborted);
        res.once('close', onClose);
        res.once('finish', cleanupConnection);
      }
      const id = regeneratePostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      if (ac.signal.aborted || req.aborted || res.destroyed) return;
      const round = Number(body.round ?? 0);
      if (!Number.isInteger(round) || round < 1) return json(res, { error: 'round 非法' }, 400);
      const compatibilityRunId = body.runId === undefined
        ? `legacy-${requestId}`
        : (isSafeOpaqueId(body.runId) ? body.runId : undefined);
      if (!compatibilityRunId) return json(res, { error: 'runId 非法' }, 400);
      let created: ReturnType<TurnJobService['create']>;
      try {
        created = turnJobs.create({
          sessionId: id,
          action: 'regenerate',
          requestId,
          originDeviceId: authenticatedContext?.device.deviceId ?? 'local-device',
          idempotencyKey: compatibilityRunId,
          compatibilityRunId,
          round,
        });
      } catch (error) {
        sse(res);
        const message = error instanceof TurnJobConflictError && error.code === 'session-turn-active'
          ? '上一回合仍在生成中，请先停止或等待完成'
          : (error as Error).message.slice(0, 200);
        sseSend(res, { type: 'error', message });
        res.end();
        return;
      }
      sse(res);
      const stopHeartbeat = startTurnSseHeartbeat(res);
      let streamStarted = false;
      const unsubscribe = turnJobs.subscribe(created.job.runId, (chunk) => {
        if (!streamStarted) {
          sseSend(res, { type: 'status', stage: 'streaming', runId: created.job.runId, round });
          streamStarted = true;
        }
        sseSend(res, { type: 'delta', text: chunk });
      });
      sseSend(res, {
        type: 'status', stage: created.job.status === 'queued' ? 'queued' : 'thinking',
        runId: created.job.runId, round,
        startedAt: Date.parse(created.job.startedAt ?? created.job.createdAt),
      });
      try {
        const settled = await turnJobs.wait(created.job.runId, ac.signal);
        const value = settled.value ?? turnJobs.valueFromCommittedJob(settled.job);
        if (settled.job.status === 'succeeded' && value?.action === 'regenerate') {
          if (!streamStarted) sseSend(res, { type: 'status', stage: 'streaming', runId: settled.job.runId, round });
          sseSend(res, {
            type: 'done', prose: value.prose, assistantMsgId: value.assistantMsgId,
            round: value.round, aborted: false, runId: settled.job.runId,
            replanSuggestion: value.replanSuggestion ?? undefined,
          });
        } else if (settled.job.status === 'cancelled') {
          sseSend(res, { type: 'done', prose: '', aborted: true, runId: settled.job.runId, round });
        } else if (settled.job.status === 'failed') {
          sseSend(res, {
            type: 'error',
            message: turnJobFailureMessage('regenerate', settled.job.error?.code),
            code: settled.job.error?.code,
          });
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          sseSend(res, { type: 'error', message: '生成任务状态读取失败' });
        }
      } finally {
        unsubscribe();
        stopHeartbeat();
      }
      cleanupConnection();
      res.end();
      return;
    }

    // 旧停止端点是显式 cancel 的兼容适配器；它不再直接持有 ChatSession AbortController。
    const turnAbortPostRoute = matchRouteTemplate('/api/session/:sessionId/turn/abort', p);
    if (method === 'POST' && turnAbortPostRoute) {
      const id = turnAbortPostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const hasRound = Object.prototype.hasOwnProperty.call(body, 'round');
      const requestedRound = hasRound ? Number(body.round) : undefined;
      if (hasRound && (!Number.isInteger(requestedRound) || (requestedRound ?? 0) < 1)) {
        return json(res, { error: 'round 非法' }, 400);
      }
      const runId = typeof body.runId === 'string' && body.runId ? body.runId : undefined;
      if (runId && !isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法' }, 400);
      try {
        const active = turnJobs.getActiveForSession(id);
        if (!runId) {
          if (active) {
            return json(res, {
              error: '活动回合需要 runId 才能停止', runId: active.runId, round: active.round,
            }, 409);
          }
          return json(res, {
            ok: true, aborted: false, alreadyFinished: true, settled: true,
            round: requestedRound ?? null, runId: null, kept: false, waited: false,
          });
        }
        const resolvedRunId = turnJobs.resolveCompatibilityRunId(id, runId);
        const existing = turnJobs.get(resolvedRunId);
        if (!existing || existing.sessionId !== id) {
          // Stop 可早于旧 SSE create 完成登记。记录短期墓碑；若当前另有活动任务，
          // 仍按 stale 返回，绝不误杀 A，但迟到的 B 会在 queued 阶段被取消。
          turnJobs.registerCompatibilityCancel(id, runId, requestedRound);
          if (!active) {
            return json(res, {
              ok: true, aborted: false, cancelledBeforeStart: true, settled: true,
              round: requestedRound ?? null, runId, kept: false, waited: false,
            });
          }
          return json(res, { error: '停止请求属于已失效回合，未中止当前回合' }, 409);
        }
        if (requestedRound !== undefined && existing.round !== requestedRound) {
          return json(res, { error: '停止请求轮次与活动任务不一致' }, 409);
        }
        const requested = turnJobs.cancel(resolvedRunId);
        if (requested.status === 'succeeded' || requested.status === 'failed') {
          return json(res, {
            ok: true, aborted: false, alreadyFinished: true, settled: true,
            round: requested.round ?? requestedRound ?? null, runId: requested.runId,
            kept: requested.status === 'succeeded', waited: false,
          });
        }
        if (requested.status === 'cancelled') {
          return json(res, {
            ok: true, aborted: true, settled: true,
            round: requested.round ?? requestedRound ?? null, runId: requested.runId,
            kept: false, waited: false,
          });
        }
        try {
          const settled = await turnJobs.wait(resolvedRunId, AbortSignal.timeout(10_000));
          return json(res, {
            ok: true,
            aborted: settled.job.status === 'cancelled',
            alreadyFinished: settled.job.status !== 'cancelled',
            settled: true,
            round: settled.job.round ?? requestedRound ?? null,
            runId: settled.job.runId,
            kept: settled.job.status === 'succeeded',
            waited: true,
          });
        } catch (error) {
          if ((error as Error).name !== 'AbortError') throw error;
          return json(res, {
            ok: true, aborted: true, settled: false,
            round: requested.round ?? requestedRound ?? null,
            runId: requested.runId, kept: false, waited: true,
          }, 202);
        }
      } catch (error) {
        return json(res, { error: (error as Error).message.slice(0, 200) }, 400);
      }
    }

    // 删除消息（round=整轮 / fromHere=从该轮到末尾；状态按回合账本回滚）
    const messageDeletePostRoute = matchRouteTemplate('/api/session/:sessionId/message/delete', p);
    if (method === 'POST' && messageDeletePostRoute) {
      const id = messageDeletePostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const round = Number(body.round ?? 0);
      const mode = body.mode === 'fromHere' ? 'fromHere' : 'round';
      if (!Number.isInteger(round) || round < 1) return json(res, { error: 'round 非法' }, 400);
      try {
        const r = session.deleteMessages(round, mode);
        scheduleLearningDrain(session);
        return json(res, { ok: true, round: r.round, mode });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    // 剧情分支索引（AI 生成，按轮缓存）。Cookie Web 使用 POST + CSRF；
    // GET 仅保留给已有 Bearer/APK 客户端兼容，仍由 route manifest 强制 csrf=always。
    const storyIndexRoute = matchRouteTemplate('/api/session/:sessionId/story-index', p);
    if ((method === 'GET' || method === 'POST') && storyIndexRoute) {
      const id = storyIndexRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      let round = 0;
      let force = false;
      if (method === 'POST') {
        const parsed = parseStoryIndexPostBody(await readBody(req) as unknown);
        if (!parsed.ok) return json(res, { error: parsed.error }, 400);
        round = parsed.round;
        force = parsed.force;
      } else {
        const urlQ = new URL(req.url ?? '/', `http://${req.headers.host}`);
        round = Number(urlQ.searchParams.get('round') ?? 0);
        force = urlQ.searchParams.get('force') === '1';
      }
      if (!Number.isSafeInteger(round) || round < 1) return json(res, { error: 'round 非法' }, 400);
      try {
        const r = await session.generateStoryIndex(round, { force });
        scheduleLearningDrain(session);
        return json(res, {
          content: r.content,
          branches: r.branches ?? [],
          branchIds: r.branchIds ?? [],
          round: r.round,
          fromCache: r.fromCache,
          stale: r.stale,
          sourceRound: r.sourceRound,
          ...(r.failureCode ? { failureCode: r.failureCode } : {}),
          ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
        });
      } catch (e) {
        if (e instanceof StoryIndexGenerationUnavailableError) {
          res.setHeader('Retry-After', String(e.retryAfterSeconds));
          return json(res, {
            error: e.message,
            code: e.code,
            reasonCode: e.diagnosticCode,
            retryAfterSeconds: e.retryAfterSeconds,
          }, 503);
        }
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    // 删除会话（关 DB + 删 data/session-*.db + 移出内存 Map）。
    // 路由必须精确匹配一个 segment，并在任何 close/delete/event 副作用前完成 containment。
    const sessionDeleteMatch = /^\/api\/session\/([^/]+)\/delete$/.exec(p);
    if (method === 'POST' && sessionDeleteMatch) {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      let id: string;
      try {
        id = decodeURIComponent(sessionDeleteMatch[1]!);
      } catch {
        return json(res, { error: '会话标识无效' }, 400);
      }
      const dbPath = resolveSessionDatabase(DATA_DIR, `${id}.db`);
      if (!dbPath) return json(res, { error: '会话标识无效' }, 400);
      const session = sessions.get(id);
      if (!existsSync(dbPath)) {
        // CAS 删除的竞争失败必须暴露当前真值 absent；否则第二个客户端只看到普通 404，
        // 无法区分“从未存在”与“基于旧 revision 的并发删除”。
        if (expected !== ABSENT_REVISION) {
          return revisionConflict(res, expected, ABSENT_REVISION, `session:${id}`);
        }
        return json(res, { error: '会话不存在' }, 404);
      }
      const actual = session
        ? snapshotForSession(session).snapshotToken
        : readSessionMeta(dbPath).snapshotToken;
      if (actual === null) {
        return json(res, {
          error: {
            code: 'snapshot_unavailable',
            message: '会话快照暂时不可用，已拒绝删除以保护本地数据',
          },
        }, 503);
      }
      if (actual !== expected) return revisionConflict(res, expected, actual, `session:${id}`);
      // 学习账本是可重建副本，但主动删除必须同时清除它；若账本不可用则隐私优先、拒绝假成功。
      if (!AGENT_LEARNING_LEDGER) {
        return json(res, {
          error: { code: 'learning_delete_unavailable', message: '学习证据暂时无法安全清理，已拒绝删除会话' },
        }, 503);
      }
      try {
        AGENT_LEARNING_LEDGER.deleteScope({ sessionId: opaqueLearningToken('session', id) });
      } catch {
        return json(res, {
          error: { code: 'learning_delete_failed', message: '学习证据清理失败，已拒绝删除会话' },
        }, 503);
      }
      try {
        ARC_PROJECTIONS?.deleteSession(id);
        maintenanceJobs.deleteSession(id);
      } catch {
        return json(res, {
          error: { code: 'arc_projection_delete_failed', message: '剧情弧投影清理失败，已拒绝删除会话' },
        }, 503);
      }
      if (session) { try { session.close(); } catch { /* 忽略 */ } }
      sessions.delete(id);
      // DSH 插件会话销毁事件（whale-widget 清理每轮消耗聚合桶）
      dshHost.emitSessionDisposed({ id, card: session?.getCardName() });
      let removed = false;
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          const f = suffix ? `${dbPath}${suffix}` : dbPath;
          if (existsSync(f)) { rmSync(f, { force: true }); removed = true; }
        }
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
      eventHub.publish({
        type: 'session.deleted',
        resource: { kind: 'session', id, revision: ABSENT_REVISION },
        requestId,
      });
      return revisionJson(res, { ok: true, removed, id, snapshotToken: ABSENT_REVISION }, ABSENT_REVISION);
    }

    const agentControlMutationAccess = (): ReturnType<typeof authorizeAgentControlMutation> => (
      authorizeAgentControlMutation({
        runtime: AGENT_CONTROL_MUTATION_RUNTIME,
        authority: authority.authority,
        localAuthorities: LOCAL_AUTHORITIES,
        accessMode: ACCESS_MODE,
        authenticatedAdmin: authenticatedContext?.isAdmin === true,
      })
    );

    if (method === 'POST' && p === '/api/agent-control') {
      const access = agentControlMutationAccess();
      if (!access.allowed) {
        req.resume();
        securityAuditSpan?.annotate({ reasonCode: access.reasonCode });
        return dshJson(res, {
          error: 'Agent 控制写入仅允许已启用的电脑本机管理员入口',
          code: access.reasonCode,
          requestId,
        }, 403);
      }
      let body: Record<string, unknown>;
      try {
        body = await readLimitedBody(req, BODY_LIMITS.authPair, { deadlineMs: 10_000 });
      } catch (error) {
        const code = error instanceof PayloadTooLargeError ? 'payload-too-large'
          : error instanceof BodyDeadlineError ? 'body-deadline' : 'json-invalid';
        const status = error instanceof PayloadTooLargeError ? 413
          : error instanceof BodyDeadlineError ? 408 : 400;
        securityAuditSpan?.annotate({ reasonCode: code });
        return dshJson(res, { error: 'Agent 控制请求体无效', code, requestId }, status);
      }
      try {
        const mutation = parseAgentControlMutation(body);
        if (mutation.operation === 'approve-worldbook-repair'
          || mutation.operation === 'apply-worldbook-repair'
          || mutation.operation === 'reject-worldbook-repair'
          || mutation.operation === 'revert-worldbook-repair') {
          if (!WORLDBOOK_REPAIR_CONTROL_PLANE) throw new Error('worldbook-repair-control-unavailable');
          const result = await WORLDBOOK_REPAIR_CONTROL_PLANE.mutate({
            mutation,
            trustedOperator: access.allowed,
          });
          if (result.assetChanged) {
            const identity = ensureAssetIdentity('worldbook', result.assetChanged.file);
            eventHub.publish({
              type: 'asset.changed',
              resource: {
                kind: 'asset',
                id: `worldbook:${identity.assetId}`,
                revision: result.assetChanged.revision,
              },
              requestId,
            });
          }
          securityAuditSpan?.annotate({ reasonCode: `worldbook-repair-${result.control.status}` });
          return json(res, { ok: true, control: result.control });
        }
        if (mutation.operation === 'approve-maintenance-proposal'
          || mutation.operation === 'reject-maintenance-proposal'
          || mutation.operation === 'rollback-maintenance-proposal') {
          const proposal = maintenanceJobs.getPendingProposal(mutation.proposalId);
          if (!proposal) {
            return dshJson(res, {
              error: '维护提案不存在', code: 'maintenance-proposal-not-found', requestId,
            }, 404);
          }
          if (mutation.operation === 'reject-maintenance-proposal') {
            const control = maintenanceJobs.rejectPendingProposal({
              proposalId: mutation.proposalId,
              expectedRevision: mutation.expectedRevision,
              reason: mutation.reasonCode,
            });
            securityAuditSpan?.annotate({ reasonCode: 'maintenance-proposal-rejected' });
            return json(res, { ok: true, control });
          }
          if (mutation.operation === 'approve-maintenance-proposal'
            && !maintenanceApplyAllowsSession(MAINTENANCE_APPLY_RUNTIME, proposal.sessionId)) {
            throw new Error('maintenance-proposal-apply-disabled');
          }
          if (!ARC_PROJECTIONS) throw new Error('maintenance-proposal-control-unavailable');
          const proposalSession = await loadSessionById(proposal.sessionId);
          if (!proposalSession) throw new Error('maintenance-proposal-session-not-found');
          const control = new MaintenanceProposalControl({
            manager: maintenanceJobs,
            arcStore: ARC_PROJECTIONS,
            currentRevision: (sessionId) => {
              if (sessionId !== proposal.sessionId) throw new Error('maintenance-proposal-session-conflict');
              return snapshotForSession(proposalSession).snapshotToken;
            },
            ...createNpcMaintenanceProposalAdapters({
              dataDir: DATA_DIR,
              currentRevision: (sessionId) => {
                if (sessionId !== proposal.sessionId) throw new Error('maintenance-proposal-session-conflict');
                return snapshotForSession(proposalSession).snapshotToken;
              },
            }),
          });
          const updated = mutation.operation === 'approve-maintenance-proposal'
            ? control.approve(mutation.proposalId, mutation.expectedRevision)
            : control.rollback(mutation.proposalId, mutation.expectedRevision);
          securityAuditSpan?.annotate({ reasonCode: `maintenance-proposal-${updated.status}` });
          return json(res, { ok: true, control: updated });
        }
        if (mutation.operation === 'clear-preference-profile') {
          const session = await loadSessionById(mutation.sessionId);
          if (!session) {
            return dshJson(res, {
              error: '会话不存在', code: 'preference-profile-session-not-found', requestId,
            }, 404);
          }
          const control = session.clearPreferenceProfiles({
            expectedRevision: mutation.expectedRevision,
            operationId: mutation.operationId,
          });
          try {
            if (!LEARNING_OUTBOX_DRAINER) throw new Error('agent-learning-ledger-unavailable');
            LEARNING_OUTBOX_DRAINER.syncPreferenceFences(session);
            hydrateLearningFromLedger(session);
            securityAuditSpan?.annotate({ reasonCode: 'agent-control-clear-preference-profile-ok' });
            return json(res, { ok: true, control: {
              revision: control.revision,
              sampleCount: control.sampleCount,
              preferenceEpoch: control.preferenceEpoch,
              removed: control.removed,
              replayed: control.replayed,
            } });
          } catch {
            // Local fence is already durable. Retry/restart replays the same operation, and every
            // drainer pass synchronizes fences before any positive sample.
            scheduleLearningDrain(session, true);
            throw new Error('preference-profile-ledger-sync-pending');
          }
        }
        const control = applyAgentControlMutation(
          AGENT_CONTROL_STORE,
          mutation,
          { styleProposals: LEARNED_STYLE_PROPOSALS },
        );
        securityAuditSpan?.annotate({ reasonCode: `agent-control-${body.operation}-ok` });
        const publicControl = mutation.operation === 'disable-style-proposal'
          || mutation.operation === 'approve-style-proposal'
          || mutation.operation === 'rollback-style-proposal'
          ? ((proposal: StyleProposal) => ({
              id: proposal.id,
              status: proposal.status,
              activeVersion: proposal.activeVersion,
              availableVersions: proposal.versions.map((version) => version.version),
              revision: proposal.revision,
            }))(control as StyleProposal)
          : control;
        return json(res, { ok: true, control: publicControl });
      } catch (error) {
        const code = error instanceof PreferenceClearOperationIntentConflictError
          ? error.code
          : error instanceof Error ? error.message : 'agent-control-mutation-failed';
        const status = code === 'agent-control-revision-conflict'
          || code === 'learning-preference-revision-conflict'
          || code === 'learning-preference-clear-operation-intent-conflict'
          || code === 'style-proposal-revision-conflict'
          || code === 'maintenance-proposal-revision-conflict'
          || code === 'npc-maintenance-rollback-revision-conflict'
          || code === 'worldbook-repair-proposal-revision-conflict'
          || code === 'worldbook-repair-source-revision-conflict'
          || code === 'worldbook-repair-revert-revision-conflict'
          || code === 'worldbook-repair-revert-source-drift'
          || code === 'worldbook-repair-session-conflict'
          || code === 'worldbook-repair-worldbook-not-bound' ? 409
          : code === 'worldbook-repair-proposal-not-found'
            || code === 'worldbook-repair-session-not-found'
            || code === 'worldbook-repair-source-not-found' ? 404
          : code === 'agent-control-escalation-denied' || code === 'lane-permanent-kill'
            || code === 'worldbook-repair-forward-disabled'
            || code === 'worldbook-repair-authority-required' ? 403
            : code === 'preference-profile-ledger-sync-pending'
              || code === 'preference-profile-control-unavailable'
              || code === 'worldbook-repair-control-unavailable' ? 503
            : code === 'lane-killed-clear-first' || code === 'lane-not-killed'
                || code === 'lane-quality-recovery-required'
                || code === 'lane-recovery-quality-kill-required'
                || code === 'lane-recovery-evidence-missing'
                || code === 'lane-recovery-evidence-not-operational'
                || code === 'lane-recovery-evidence-stale-recorded-at'
                || code === 'lane-recovery-evidence-stale-captured-at'
                || code === 'capability-not-killed'
                || code === 'style-proposal-already-disabled'
                || code === 'style-proposal-already-enabled'
                || code === 'style-proposal-not-enabled'
                || code === 'style-proposal-rollback-version-invalid'
                || code === 'agent-control-noop' ? 409 : 400;
        const publicCode = /^agent-control-[a-z-]+$|^lane-[a-z-]+$|^capability-[a-z-]+$|^style-proposal-[a-z-]+$|^learning-preference-[a-z-]+$|^preference-profile-[a-z-]+$|^maintenance-proposal-[a-z-]+$|^npc-maintenance-[a-z-]+$|^worldbook-repair-[a-z-]+$/u.test(code)
          ? code : 'agent-control-mutation-failed';
        securityAuditSpan?.annotate({ reasonCode: publicCode });
        return dshJson(res, { error: 'Agent 控制操作未应用', code: publicCode, requestId }, status);
      }
    }

    // 会话 Agent 状态
    const agentControlGetRoute = matchRouteTemplate('/api/session/:sessionId/agent-control', p);
    if (method === 'GET' && agentControlGetRoute) {
      const id = agentControlGetRoute.sessionId;
      const dbPath = resolveSessionDatabase(DATA_DIR, `${id}.db`);
      if (!dbPath || !existsSync(dbPath)) return json(res, { error: '会话不存在' }, 404);
      const mutationAccess = agentControlMutationAccess();
      const loadedSession = sessions.get(id);
      const opaqueSessionId = opaqueLearningToken('session', id);
      const learningIdentity = loadedSession?.learningProfileIdentity()
        ?? readSessionLearningIdentity(dbPath, id);
      const preferenceSyncState = learningIdentity
        ? readSessionPreferenceSyncState({
            ledger: AGENT_LEARNING_LEDGER,
            dbPath,
            identity: learningIdentity,
          })
        : undefined;
      const effectiveLearning = preferenceSyncState === 'synced' && learningIdentity
        ? readSessionEffectiveLearning({
            ledger: AGENT_LEARNING_LEDGER,
            dbPath,
            rawSessionId: id,
            loadedIdentity: learningIdentity,
          })
        : undefined;
      const preferenceProfile = mutationAccess.allowed
        ? (loadedSession?.preferenceControlState()
          ?? (learningIdentity ? readSessionPreferenceEvidenceState(dbPath, learningIdentity) : null))
        : null;
      return json(res, readSessionAgentControl({
        rawSessionId: id,
        opaqueSessionId,
        controlStore: AGENT_CONTROL_STORE,
        admissionLedger: AGENT_ADMISSION_LEDGER,
        allowedActions: {
          canChangeLane: mutationAccess.allowed,
          canKill: mutationAccess.allowed,
          canClearKill: mutationAccess.allowed,
          canClearProfile: mutationAccess.allowed && preferenceProfile !== null,
          canApprove: mutationAccess.allowed,
          canRollback: mutationAccess.allowed,
        },
        ...(mutationAccess.allowed ? { styleProposals: LEARNED_STYLE_PROPOSALS.list() } : {}),
        ...(preferenceProfile ? { preferenceProfile } : {}),
        ...(effectiveLearning ? { effectiveLearning } : {}),
        ...(preferenceSyncState ? { preferenceSyncState } : {}),
        maintenanceProposals: maintenanceJobs.listPendingProposals(id).map((proposal) => ({
            id: proposal.proposalId,
            taskKind: proposal.taskKind,
            status: proposal.status,
            proposalDigest: proposal.proposalDigest,
            itemCount: Number(proposal.diff.itemCount ?? 0),
            revision: proposal.revision,
            applySupported: maintenanceProposalApplySupported(
              MAINTENANCE_APPLY_RUNTIME,
              id,
              proposal.taskKind,
            ),
            createdAt: proposal.createdAt,
            updatedAt: proposal.updatedAt,
          })),
        worldbookRepairProposals: WORLDBOOK_REPAIR_CONTROL_PLANE?.list(id, 50) ?? Object.freeze([]),
      }));
    }

    // 会话历史
    const historyGetRoute = matchRouteTemplate('/api/session/:sessionId/history', p);
    if (method === 'GET' && historyGetRoute) {
      const id = historyGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const snapshot = snapshotForSession(session);
      return revisionJson(res, {
        messages: session.getHistory(),
        snapshotToken: snapshot.snapshotToken,
      }, snapshot.snapshotToken);
    }

    // 会话配置（启动流程审查：世界书/预设/引擎 回显）
    const configGetRoute = matchRouteTemplate('/api/session/:sessionId/config', p);
    if (method === 'GET' && configGetRoute) {
      const id = configGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const snapshot = snapshotForSession(session);
      return revisionJson(res, {
        config: session.getSessionConfig(),
        snapshotToken: snapshot.snapshotToken,
      }, snapshot.snapshotToken);
    }

    // 会话聚合一致快照：供双端同步与未来后台 Harness 固定输入版本。
    const snapshotGetRoute = matchRouteTemplate('/api/session/:sessionId/snapshot', p);
    if (method === 'GET' && snapshotGetRoute) {
      const id = snapshotGetRoute.sessionId;
      const session = sessions.get(id) ?? await loadSessionById(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const snapshot = snapshotForSession(session);
      return revisionJson(res, {
        snapshotToken: snapshot.snapshotToken,
        databaseRevision: snapshot.databaseRevision,
        rowCounts: snapshot.rowCounts,
        assets: snapshot.assets,
      }, snapshot.snapshotToken);
    }

    // 记忆控制台：双通道检索调试
    const memorySearchPostRoute = matchRouteTemplate('/api/session/:sessionId/memory-search', p);
    if (method === 'POST' && memorySearchPostRoute) {
      const id = memorySearchPostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const query = String(body.query ?? '').trim();
      if (!query) return json(res, { error: '查询为空' }, 400);
      const r = session.debugSearch(query);
      return json(res, {
        hits: r.hits.map((h) => ({ code: h.code, category: h.category, source: h.source, score: Number(h.score.toFixed(3)), confidence: h.confidence, content: h.content.slice(0, 80) })),
        layerStats: r.layerStats,
        elapsedMs: r.elapsedMs,
      });
    }

    // 记忆控制台：状态表 + 大纲表 + 元数据
    const memoryStateGetRoute = matchRouteTemplate('/api/session/:sessionId/memory-state', p);
    const memoryArcGetRoute = matchRouteTemplate('/api/session/:sessionId/memory-arc', p);
    const memoryMetaGetRoute = matchRouteTemplate('/api/session/:sessionId/memory-meta', p);
    const memoryGetRoute = memoryStateGetRoute ?? memoryArcGetRoute ?? memoryMetaGetRoute;
    if (method === 'GET' && memoryGetRoute) {
      const id = memoryGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      if (memoryStateGetRoute) return json(res, { states: session.getStateRows(), headVersion: session.memoryHeadVersion() });
      if (memoryArcGetRoute) return json(res, { arcs: session.getArcRows(), headVersion: session.memoryHeadVersion() });
      return json(res, { meta: session.getMeta(), headVersion: session.memoryHeadVersion() });
    }

    // AM-05：人物投影（**只读**；记忆面板自动同步与诊断复用同一读取入口）
    //  · 打开/刷新/补读本端点：额外模型调用 = 0、记忆业务写入 = 0、向量重建 = 0
    const charactersGetRoute = matchRouteTemplate('/api/session/:sessionId/characters', p);
    if (method === 'GET' && charactersGetRoute) {
      const id = charactersGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      return json(res, {
        characters: session.getCharacterProjections(),
        pending: session.getCharacterPending(),
        // AM-07：人物临时层（已出现、未到促升阈值的候选 + 阈值）。
        // 只读投影：池子**不进 prompt**，这里多返回一项不产生模型调用/记忆写入。
        pool: session.getCharacterPool(),
        headVersion: session.memoryHeadVersion(),
      });
    }

    // 世界书激活调试（P2）
    const lorebookScanPostRoute = matchRouteTemplate('/api/session/:sessionId/lorebook-scan', p);
    if (method === 'POST' && lorebookScanPostRoute) {
      const id = lorebookScanPostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const input = String(body.input ?? '').trim();
      if (!input) return json(res, { error: '输入为空' }, 400);
      const r = session.debugScan(input);
      return json(res, {
        activated: r.activated.map((e) => ({ comment: e.comment, matchType: e.matchType, content: e.content.slice(0, 60), constant: e.constant })),
        stats: r.stats,
      });
    }

    // 变量控制台（VMS：声明 + 求值 + 依赖分层）
    const variablesGetRoute = matchRouteTemplate('/api/session/:sessionId/variables', p);
    if (method === 'GET' && variablesGetRoute) {
      const id = variablesGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const v = session.getVariables();
      return json(res, {
        decls: v.decls.map((d) => ({ name: d[0], type: d[1], expr: d[2] })),
        // 合并会话级全局变量（ST global 作用域）：卡读回 statusBarSettings 等前端设置项
        values: { ...v.values, ...session.getGlobalVars() },
        layers: v.layers,
        errors: v.errors,
        headVersion: session.memoryHeadVersion(),
      });
    }

    // 推进槽 / 事件类型 / NSFW 锁定（P2）
    const turnStateGetRoute = matchRouteTemplate('/api/session/:sessionId/turn-state', p);
    if (method === 'GET' && turnStateGetRoute) {
      const id = turnStateGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      return json(res, { state: session.getTurnState(), generation: session.getActiveTurnState(), headVersion: session.memoryHeadVersion() });
    }

    // FE-B2：会话级共享脚本运行包（按清单依赖顺序下发真实脚本文本，前端注入到卡脚本之前）
    const sharedScriptsGetRoute = matchRouteTemplate('/api/session/:sessionId/shared-scripts', p);
    if (method === 'GET' && sharedScriptsGetRoute) {
      const id = sharedScriptsGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const bundle = session.getSharedScriptBundle();
      if (!bundle) return json(res, { error: '本会话无脚本清单（未导入角色卡或卡无 tavern_helper 脚本）' }, 404);
      return json(res, bundle);
    }

    // 权威状态快照（FE-C1）：session（会话）或 message（按稳定消息身份 / 楼层翻译）
    //  · exists=false 表示**未初始化**，调用方不得用 {} 冒充已加载
    //  · 楼层不存在 → resolved=false（明确拒绝，不回退到"最新状态"）
    const stateGetRoute = matchRouteTemplate('/api/session/:sessionId/state', p);
    if (method === 'GET' && stateGetRoute) {
      const id = stateGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const scope: 'session' | 'message' = url.searchParams.get('scope') === 'session' ? 'session' : 'message';
      const floorRaw = url.searchParams.get('floor');
      const msgRaw = url.searchParams.get('message_id');
      const idxRaw = url.searchParams.get('message_index');
      const ref: { scope: 'session' | 'message'; floor?: number; messageId?: number; messageIndex?: number } = {
        scope,
        floor: floorRaw !== null && floorRaw !== '' ? Number(floorRaw) : undefined,
        messageId: msgRaw !== null && msgRaw !== '' ? Number(msgRaw) : undefined,
        messageIndex: idxRaw !== null && idxRaw !== '' ? Number(idxRaw) : undefined,
      };
      if (scope === 'message' && ref.floor === undefined && ref.messageId === undefined && ref.messageIndex === undefined) {
        return json(res, { error: 'message 作用域必须提供 floor / message_id / message_index 之一' }, 400);
      }
      return json(res, session.getStateByRef(ref));
    }

    // FE-04-A：**回合 → 消息 → 状态** 可追踪记录（只读验收接口）
    //  返回：逻辑回合、持久消息身份、状态实例归属、该回合是否已提交状态快照（含溯源）
    const turnTraceGetRoute = matchRouteTemplate('/api/session/:sessionId/turn-trace', p);
    if (method === 'GET' && turnTraceGetRoute) {
      const id = turnTraceGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const roundRaw = url.searchParams.get('round');
      const round = roundRaw !== null && roundRaw !== '' ? Number(roundRaw) : 0;
      if (!Number.isFinite(round) || round < 0) return json(res, { error: 'round 必须为非负整数' }, 400);
      const trace = session.turnTrace(round);
      const state = session.getStateByRef({ scope: 'message', floor: round });
      // cleared 只在**该回合确实没有状态快照**时给出（有快照却报"无状态"是误导）
      const cleared = state.resolved && state.exists ? undefined : '本回合无状态快照';
      return json(res, {
        ok: true, ...trace, cleared,
        state: {
          resolved: state.resolved, messageId: state.messageId ?? null, exists: state.exists,
          stateVersion: state.stateVersion, source: state.source ?? null, note: state.note ?? null,
        },
      });
    }

    // 权威状态提交（同一提交链：幂等 operationId + 乐观锁 expectedVersion + 实例归属 instanceId）
    const statePostRoute = matchRouteTemplate('/api/session/:sessionId/state', p);
    if (method === 'POST' && statePostRoute) {
      const id = statePostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const st = body.state;
      if (!st || typeof st !== 'object' || Array.isArray(st)) return json(res, { error: 'state 必须为对象' }, 400);
      const scope: 'session' | 'message' = body.scope === 'session' ? 'session' : 'message';
      const ref: { scope: 'session' | 'message'; floor?: number; messageId?: number; messageIndex?: number } = {
        scope,
        floor: typeof body.floor === 'number' ? body.floor : undefined,
        messageId: typeof body.message_id === 'number' ? body.message_id : undefined,
        messageIndex: typeof body.message_index === 'number' ? body.message_index : undefined,
      };
      if (scope === 'message' && ref.floor === undefined && ref.messageId === undefined && ref.messageIndex === undefined) {
        return json(res, { error: 'message 作用域必须提供 floor / message_id / message_index 之一' }, 400);
      }
      const r = session.commitStateByRef(ref, st as Record<string, unknown>, {
        operationId: typeof body.operationId === 'string' && body.operationId ? body.operationId : undefined,
        expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
        instanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
      });
      if (!r.ok) return json(res, { error: r.error, code: r.code }, r.code === 'unresolved' ? 404 : 409);
      return json(res, r);
    }

    // 已保存状态作用域清单（诊断：session / message 各自是否存在）
    const stateScopesGetRoute = matchRouteTemplate('/api/session/:sessionId/state-scopes', p);
    if (method === 'GET' && stateScopesGetRoute) {
      const id = stateScopesGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      return json(res, { scopes: session.listStateScopes() });
    }

    // MVU 权威状态快照（UP-05 兼容别名；FE-C1 起不再依赖引擎对象存在）
    const mvuStateGetRoute = matchRouteTemplate('/api/session/:sessionId/mvu-state', p);
    if (method === 'GET' && mvuStateGetRoute) {
      const id = mvuStateGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      return json(res, session.getMvuState());
    }

    // MVU 更新（UP-05）：二选一 ——
    //   { state }                整状态替换（对应 ST 的 Mvu.replaceMvuData({stat_data})，用于第 0 楼写入）
    //   { ops, expectedVersion } 结构化路径更新
    // 均可带 scope/floor/message_id 指定楼层作用域（FE-C1）
    const mvuUpdatePostRoute = matchRouteTemplate('/api/session/:sessionId/mvu-update', p);
    if (method === 'POST' && mvuUpdatePostRoute) {
      const id = mvuUpdatePostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const ref = {
        scope: (body.scope === 'session' ? 'session' : 'message') as 'session' | 'message',
        floor: typeof body.floor === 'number' ? body.floor : undefined,
        messageId: typeof body.message_id === 'number' ? body.message_id : undefined,
        messageIndex: typeof body.message_index === 'number' ? body.message_index : undefined,
      };
      const opts = {
        operationId: typeof body.operationId === 'string' && body.operationId ? body.operationId : undefined,
        instanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
      };

      if (body.state !== undefined) {
        const state = body.state;
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
          return json(res, { error: 'state 必须为对象' }, 400);
        }
        const replaced = session.replaceMvuState(
          state as Record<string, unknown>,
          ref,
          { ...opts, expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined },
        );
        if (!replaced.ok) return json(res, { error: replaced.error, code: replaced.code }, replaced.code === 'unresolved' ? 404 : 409);
        return json(res, replaced);
      }

      const rawOps = Array.isArray(body.ops) ? body.ops : null;
      if (!rawOps || rawOps.length === 0) return json(res, { error: 'ops 必须为非空数组（或改用 state 整替换）' }, 400);
      const ops: { op: 'set' | 'delete'; path: string; value?: unknown }[] = [];
      for (const raw of rawOps) {
        if (!raw || typeof raw !== 'object') return json(res, { error: '每个 op 必须为对象' }, 400);
        const o = raw as Record<string, unknown>;
        if (typeof o.path !== 'string' || !o.path) return json(res, { error: 'op.path 必须为非空字符串' }, 400);
        if (o.op === 'set') ops.push({ op: 'set', path: o.path, value: o.value });
        else if (o.op === 'delete') ops.push({ op: 'delete', path: o.path });
        else return json(res, { error: `不支持的 op: ${String(o.op)}` }, 400);
      }
      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
      const result = session.applyMvuUpdates(ops, expectedVersion, ref);
      if (!result.ok) return json(res, { error: result.error, code: result.code }, result.code === 'unresolved' ? 404 : 409);
      return json(res, result);
    }

    // ── FE-01/FE-02：世界书读写（TavernHelper 形状）+ 会话级全局变量 ──

    // 会话主世界书条目（TavernHelper 形状：uid/name/key/content/enabled）
    // 卡按 e.name.includes('[initvar]') 定位条目、按 uid 回写，故必须归一化（磁盘原生形状是 id/comment/keys）
    const worldbookEntriesGetRoute = matchRouteTemplate('/api/session/:sessionId/worldbook-entries', p);
    if (method === 'GET' && worldbookEntriesGetRoute) {
      const id = worldbookEntriesGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const requested = String(url.searchParams.get('name') ?? session.getPrimaryWorldbook() ?? '').trim();
      if (!requested) return json(res, { error: '本会话未绑定世界书' }, 404);
      const file = readAssetReference('worldbook', requested);
      if (!file) return json(res, { error: '世界书引用非法' }, 400);
      const asset = readRevisionedAsset('worldbook', file);
      if (!asset) return json(res, { error: `世界书不存在: ${file}` }, 404);
      let parsed: unknown;
      try { parsed = JSON.parse(asset.raw); } catch { return json(res, { error: '世界书 JSON 解析失败' }, 500); }
      const { entries } = rawEntriesOf(parsed);
      return revisionJson(res, { file, source: asset.source, entries: entries.map((e, i) => toTavernHelperEntry(e, i)) }, asset.revision);
    }

    // 世界书写回：仅提交**变化条目**（按 uid 回填原始条目对象，保留未知字段）
    const worldbookUpdatePostRoute = matchRouteTemplate('/api/session/:sessionId/worldbook-update', p);
    if (method === 'POST' && worldbookUpdatePostRoute) {
      const id = worldbookUpdatePostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const requestedName = String(body.name ?? session.getPrimaryWorldbook() ?? '').trim();
      const changed = Array.isArray(body.changed) ? body.changed as TavernHelperEntry[] : [];
      if (!requestedName) return json(res, { error: '缺少世界书文件名' }, 400);
      const file = readAssetReference('worldbook', requestedName);
      if (!file) return json(res, { error: '世界书引用非法' }, 400);
      if (changed.length === 0) return json(res, { error: 'changed 为空，未提交任何写入' }, 400);
      const asset = readRevisionedAsset('worldbook', file);
      if (!asset) return json(res, { error: `世界书不存在: ${file}` }, 404);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(asset.raw) as Record<string, unknown>; } catch { return json(res, { error: '世界书 JSON 解析失败' }, 500); }
      const { applied, missed } = applyChangedEntries(parsed, changed);
      // 一条都没匹配上：明确失败，不得回「成功」（防止「界面提示保存成功但实际没写」）
      if (applied === 0) {
        return json(res, { error: `变更条目未能匹配任何现有条目（uid 不匹配）`, missed }, 409);
      }
      try {
        const mutation = saveUserAssetCas('worldbook', file, JSON.stringify(parsed, null, 2), expected);
        const { entries } = rawEntriesOf(parsed);
        const identity = ensureAssetIdentity('worldbook', file);
        eventHub.publish({
          type: 'asset.changed',
          resource: { kind: 'asset', id: `worldbook:${identity.assetId}`, revision: mutation.revision },
          requestId,
        });
        return revisionJson(res, {
          assetId: identity.assetId,
          file,
          applied,
          missed,
          entries: entries.map((e, i) => toTavernHelperEntry(e, i)),
        }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        throw error;
      }
    }

    // 会话级全局变量（ST global 作用域）：读 = VMS 求值值 + globals 合并；写 = 落 memory_meta.config.globals
    const variablesReplacePostRoute = matchRouteTemplate('/api/session/:sessionId/variables-replace', p);
    if (method === 'POST' && variablesReplacePostRoute) {
      const id = variablesReplacePostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const values = body.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return json(res, { error: 'values 必须为对象' }, 400);
      }
      const merged = session.setGlobalVars(values as Record<string, unknown>);
      return json(res, { ok: true, values: merged });
    }

    // ── P4 ProviderRegistry 管理面（公开 descriptor 白名单；不含 key/baseUrl/cookie）──
    if (method === 'GET' && p === '/api/providers') {
      const cfg = loadProviderConfig();
      const providers = providerRegistry.list();
      return json(res, {
        ok: true,
        enabled: PROVIDER_SPI_ENABLED,
        providers,
        selectedProviderId: cfg.providerId,
        model: cfg.model,
        selectedAvailable: providers.some((provider) => provider.id === cfg.providerId),
      });
    }

    if (method === 'POST' && p === '/api/providers/select') {
      if (!PROVIDER_SPI_ENABLED) {
        return json(res, {
          ok: false,
          code: 'provider-spi-disabled',
          error: 'Provider SPI 已由 JG_PROVIDER_SPI=0 关闭',
        }, 409);
      }
      const body = await readBody(req);
      const providerId = String(body.providerId ?? '').trim();
      if (!providerId) return json(res, { ok: false, error: '缺少 providerId' }, 400);
      if (providerId === COMMANDCODE_PROVIDER_ID) {
        try {
          await refreshCommandCodeProviderCredentialState();
        } catch {
          return json(res, {
            ok: false,
            code: 'provider-refresh-failed',
            error: 'CommandCode Provider 刷新失败；请检查电脑端插件配置或重启酒馆',
          }, 503);
        }
      }
      const descriptor = providerRegistry.describe(providerId);
      if (!descriptor) {
        return json(res, {
          ok: false,
          code: 'not-found',
          error: `Provider 不可用: ${providerId}`,
        }, 404);
      }
      const model = body.model === undefined ? undefined : String(body.model).trim();
      if (model !== undefined && (!model || model.length > 256)) {
        return json(res, { ok: false, error: 'model 非法' }, 400);
      }
      const { writeProviderJson } = await import('../../packages/proxy/src/config.ts');
      writeProviderJson({
        providerId,
        ...(model === undefined ? {} : { model }),
      });
      const cfg = refreshProviderConfiguration();
      return json(res, {
        ok: true,
        selectedProviderId: cfg.providerId,
        model: cfg.model,
        provider: providerRegistry.describe(cfg.providerId),
      });
    }

    const providerAction = providerActionPath(p);
    if (providerAction && method === 'GET' && providerAction.action === 'models') {
      try {
        const models = await providerRegistry.listModels(providerAction.id, {
          requestId: randomUUID(),
          signal: AbortSignal.timeout(15_000),
        });
        return json(res, { ok: true, models });
      } catch (error) {
        return providerFailure(res, error);
      }
    }
    if (providerAction && method === 'POST' && providerAction.action === 'health') {
      try {
        const health = await providerRegistry.health(providerAction.id, {
          requestId: randomUUID(),
          signal: AbortSignal.timeout(15_000),
        });
        return json(res, { ok: health.ok, health });
      } catch (error) {
        return providerFailure(res, error);
      }
    }

    // Provider 配置（非敏感：不含 key）
    if (method === 'GET' && p === '/api/provider') {
      const cfg = (await import('../../packages/proxy/src/config.ts')).loadProviderConfig();
      return json(res, {
        providerId: cfg.providerId,
        providerSpiEnabled: PROVIDER_SPI_ENABLED,
        baseUrl: cfg.baseUrl, model: cfg.model, kind: cfg.kind, prefixCacheThreshold: cfg.prefixCacheThreshold,
        hasKey: Boolean(cfg.apiKey), keySource: cfg.keySource, keyFingerprint: cfg.keyFingerprint,
      });
    }

    // Provider 测试连接（校验草稿 baseUrl/key + 拉取模型列表；草稿值不落盘）
    if (method === 'POST' && p === '/api/provider/test') {
      const { loadProviderConfig } = await import('../../packages/proxy/src/config.ts');
      const body = await readBody(req);
      const overrides = {
        ...(body.baseUrl ? { baseUrl: String(body.baseUrl) } : {}),
        ...(body.apiKey ? { apiKey: String(body.apiKey) } : {}),
        ...(body.model ? { model: String(body.model) } : {}), // 记录历史模型用表单值，避免落回已保存/默认模型
      };
      const cfg = loadProviderConfig(overrides);
      if (!cfg.apiKey) {
        return json(res, { ok: false, error: '缺少 API key：请在下方填入 key 后测试，或在 .env.local 配置 JG_API_KEY' }, 400);
      }
      const client = new OpenAICompatibleClient(cfg);
      try {
        const models = await client.listModels();
        // 测试成功 → 记忆该 URL+模型（best-effort 旁路：写盘失败不拖垮成功响应）
        let history: { baseUrl: string; model: string; lastSuccessAt: string }[] = [];
        try {
          const h = await import('../../packages/proxy/src/history.ts');
          history = h.recordProviderUrl(cfg.baseUrl, cfg.model);
        } catch { /* 历史记忆失败忽略 */ }
        return json(res, { ok: true, models: models.slice(0, 50), count: models.length, baseUrl: cfg.baseUrl, model: cfg.model, history });
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = (e as Error).message.slice(0, 300);
        const where = status ? `HTTP ${status}` : '网络';
        return json(res, { ok: false, error: `连接失败（${where}）：${msg}`, status: status ?? 0 }, status && status >= 400 ? status : 502);
      }
    }

    // Provider 写 key（启动流程审查 P0-2：UI 填写 → data/provider.json 立即热更，不回显）
    if (method === 'POST' && p === '/api/provider/key') {
      const { writeProviderJson, loadProviderConfig } = await import('../../packages/proxy/src/config.ts');
      const body = await readBody(req);
      const apiKey = (body.apiKey ?? '').toString().trim();
      if (!apiKey) return json(res, { error: 'API key 为空' }, 400);
      writeProviderJson({ apiKey });
      const cfg = refreshProviderConfiguration();
      try {
        await refreshCommandCodeProviderCredentialState();
      } catch {
        return json(res, {
          ok: false,
          saved: true,
          code: 'provider-refresh-failed',
          error: 'API key 已保存，但 CommandCode Provider 刷新失败；请检查电脑端插件配置或重启酒馆',
        }, 503);
      }
      return json(res, { ok: true, hasKey: Boolean(cfg.apiKey), baseUrl: cfg.baseUrl, model: cfg.model, keyFingerprint: cfg.keyFingerprint });
    }

    // Provider 统一保存（baseUrl / model / key → data/provider.json 立即热更会话；key 不回显）
    if (method === 'POST' && p === '/api/provider/save') {
      const { writeProviderJson, loadProviderConfig } = await import('../../packages/proxy/src/config.ts');
      const body = await readBody(req);
      const partial: Record<string, unknown> = {};
      if (body.baseUrl) partial.baseUrl = String(body.baseUrl).trim().replace(/\/+$/, '');
      if (body.model) partial.model = String(body.model).trim();
      if (body.apiKey) partial.apiKey = String(body.apiKey).trim();
      if (body.kind === 'anthropic' || body.kind === 'openai') partial.kind = body.kind;
      if (body.prefixCacheThreshold) partial.prefixCacheThreshold = Number(body.prefixCacheThreshold);
      if (Object.keys(partial).length === 0) {
        return json(res, { error: '无可保存的配置（Base URL / 模型 / API key 至少填一项）' }, 400);
      }
      writeProviderJson(partial);
      const cfg = refreshProviderConfiguration();
      if (partial.apiKey !== undefined) {
        try {
          await refreshCommandCodeProviderCredentialState();
        } catch {
          return json(res, {
            ok: false,
            saved: true,
            code: 'provider-refresh-failed',
            error: 'Provider 配置已保存，但 CommandCode Provider 刷新失败；请检查电脑端插件配置或重启酒馆',
          }, 503);
        }
      }
      return json(res, {
        ok: true,
        providerId: cfg.providerId,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        kind: cfg.kind,
        hasKey: Boolean(cfg.apiKey),
        keySource: cfg.keySource,
        keyFingerprint: cfg.keyFingerprint,
        prefixCacheThreshold: cfg.prefixCacheThreshold,
      });
    }

    // Provider 历史 URL（测试成功自动记录，不含 key）—— 面板下拉快速切换
    if (method === 'GET' && p === '/api/provider/history') {
      const { readProviderHistory } = await import('../../packages/proxy/src/history.ts');
      return json(res, { ok: true, history: readProviderHistory() });
    }

    // Provider 历史删除（POST 兼容 CORS：json() 只放行 GET/POST/OPTIONS；body: {baseUrl} | {all:true}）
    if (method === 'POST' && p === '/api/provider/history/delete') {
      const { readProviderHistory, removeProviderUrl, writeProviderHistory } = await import('../../packages/proxy/src/history.ts');
      const body = await readBody(req);
      if ((body as { all?: unknown }).all === true) {
        writeProviderHistory([]);
        return json(res, { ok: true, history: [] });
      }
      const baseUrl = String(body.baseUrl ?? '').trim();
      if (!baseUrl) return json(res, { error: '缺少要删除的 Base URL（或传 all:true 清空）' }, 400);
      return json(res, { ok: true, history: removeProviderUrl(baseUrl) });
    }

    // ── GLA 远端资源（扫描 / 受保护预载 / 缓存只读出图；全局缓存 %TEMP%/jiuguan-assets） ──

    if (method === 'GET' && p === '/api/assets/status') {
      const m = loadManifest(ASSET_DIR);
      const cache = new DiskCache(ASSET_DIR);
      const entries = AUTH_RUNTIME
        ? m.entries.map(publicAssetDescriptor)
        : m.entries.map((e) => ({ id: e.id, url: e.url, kind: e.kind, name: e.name, cached: e.cached, bytes: e.bytes, failed: e.failed, sourceCard: e.sourceCard }));
      return json(res, {
        ok: true,
        total: m.entries.length,
        cachedCount: m.entries.filter((e) => e.cached).length,
        failedCount: m.entries.filter((e) => e.failed).length,
        diskBytes: cache.diskBytes(),
        scannedAt: m.scannedAt,
        byKind: countByKind(m.entries),
        entries,
      });
    }

    // 扫描角色卡 → 建资产索引并入 manifest（不下载）
    if (method === 'POST' && p === '/api/assets/scan') {
      const body = await readBody(req);
      const card = readAssetReference('card', body.assetId ?? body.card);
      if (!card) return json(res, { error: '缺少 card 参数' }, 400);
      const ct = readCardText(card);
      if (!ct) return json(res, { error: '角色卡不存在' }, 404);
      const m = loadManifest(ASSET_DIR);
      const entries = buildAssetIndex(ct.raw, card);
      const { added } = mergeAssetIndex(m, entries);
      saveManifest(m, ASSET_DIR);
      return json(res, { ok: true, added, total: m.entries.length, counts: countByKind(m.entries), cachedCount: m.entries.filter((e) => e.cached).length });
    }

    // 预载全部资源（SSE 进度；失败逐条记录，允许重试）
    if (method === 'POST' && p === '/api/assets/preload') {
      const body = await readBody(req);
      const card = readAssetReference('card', body.assetId ?? body.card);
      sse(res);
      const abortMsg = (message: string): void => { sseSend(res, { type: 'error', message }); res.end(); };
      if (!card) return abortMsg('角色卡不存在');
      const ct = readCardText(card);
      if (!ct) return abortMsg('角色卡不存在');
      const m = loadManifest(ASSET_DIR);
      const entries = buildAssetIndex(ct.raw, card);
      mergeAssetIndex(m, entries);
      const cache = new DiskCache(ASSET_DIR);
      // 待下载 = 磁盘尚无缓存文件者（含此前 failed 的重试）；已缓存即跳过（幂等）
      const pending = m.entries.filter((e) => !cache.has(e.id)).map((e) => e.url);
      if (pending.length === 0) {
        saveManifest(m, ASSET_DIR);
        sseSend(res, { type: 'done', done: 0, total: 0, failed: [], downloadedBytes: 0 });
        return res.end();
      }
      let downloadedBytes = 0;
      const byUrl = new Map(m.entries.map((e) => [e.url, e]));
      const onProgress = (ev: { url: string; ok: boolean; bytes?: number; error?: string; done: number; total: number }): void => {
        const entry = byUrl.get(ev.url);
        if (entry) {
          entry.cached = ev.ok;
          entry.failed = ev.ok ? undefined : (ev.error ?? 'download failed');
          if (ev.ok && ev.bytes) { entry.bytes = ev.bytes; downloadedBytes += ev.bytes; }
        }
        sseSend(res, {
          type: 'progress',
          done: ev.done,
          total: ev.total,
          ...(AUTH_RUNTIME ? { assetId: entry?.id } : { url: ev.url.slice(0, 140) }),
          ok: ev.ok,
          error: ev.error,
          kind: entry?.kind,
          name: entry?.name,
        });
      };
      const { failed } = await downloadAll(pending, cache, onProgress, 4, 30000, {
        signal: requestAbortController?.signal,
      });
      saveManifest(m, ASSET_DIR);
      sseSend(res, {
        type: 'done',
        done: pending.length - failed.length,
        total: pending.length,
        failed: AUTH_RUNTIME
          ? failed.map((item) => ({ assetId: assetId(item.url), error: item.error }))
          : failed,
        downloadedBytes,
      });
      res.end();
    }

    // 已认证批量签发：只接受 assetId + purpose，不接受 URL。
    if (method === 'POST' && p === '/api/assets/capabilities') {
      if (!AUTH_RUNTIME || !authenticatedContext?.session) {
        return json(res, { error: '认证未启用', code: 'auth-disabled' }, 404);
      }
      const body = await readBody(req);
      const requests = Array.isArray(body.requests) ? body.requests : [];
      if (requests.length === 0 || requests.length > 64 || !requests.every(isAssetCapabilityRequest)) {
        return json(res, { error: 'capability 请求形状不正确', code: 'asset-capability-request-invalid' }, 400);
      }
      const manifest = loadManifest(ASSET_DIR);
      const cache = new DiskCache(ASSET_DIR);
      const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
      const unique = new Map<string, { assetId: string; purpose: AssetCapabilityPurpose }>();
      for (const request of requests) {
        unique.set(`${request.assetId}:${request.purpose}`, request);
      }
      const prepared: { entry: (typeof manifest.entries)[number]; purpose: AssetCapabilityPurpose; bytes: number }[] = [];
      for (const request of unique.values()) {
        const entry = entries.get(request.assetId);
        const bytes = entry ? cache.size(entry.id) : null;
        if (!entry || bytes === null || assetPurposeForUrl(entry.url) !== request.purpose) {
          return json(res, { error: '资产不存在、未缓存或用途不匹配', code: 'asset-capability-target-invalid' }, 404);
        }
        prepared.push({ entry, purpose: request.purpose, bytes });
      }
      const capabilities = prepared.map(({ entry, purpose, bytes }) => AUTH_RUNTIME.issueAssetCapability({
        assetId: entry.id,
        targetDigest: AuthRuntime.assetTargetDigest(entry.url),
        purpose,
        session: authenticatedContext!.session!,
        bytes,
        now: () => new Date().toISOString(),
      }));
      return json(res, { capabilities });
    }

    // P8-05：设备认证只用于签发；下载正文只携带短期 capability。
    if (method === 'POST' && p === '/api/assets/download-capabilities') {
      if (!AUTH_RUNTIME || !authenticatedContext?.session) {
        return json(res, { error: '认证未启用', code: 'auth-disabled' }, 404);
      }
      const body = await readBody(req);
      if (!isAssetDownloadRequest(body)) {
        return json(res, { error: '下载请求形状不正确', code: 'asset-download-request-invalid' }, 400);
      }
      const identity = ASSET_IDENTITIES.getById(body.assetId);
      const prepared = identity ? prepareAssetDownload(identity, body.format) : null;
      if (!identity || !prepared) {
        return json(res, { error: '资产不存在或格式不可用', code: 'asset-download-target-invalid' }, 404);
      }
      const capability = AUTH_RUNTIME.issueAssetCapability({
        assetId: identity.assetId,
        targetDigest: prepared.targetDigest,
        purpose: 'download',
        session: authenticatedContext.session,
        bytes: prepared.body.length,
        now: () => new Date().toISOString(),
      });
      const download: AssetDownloadGrant = {
        ...capability,
        purpose: 'download',
        format: prepared.format,
        filename: prepared.filename,
        mediaType: prepared.mediaType,
        bytes: prepared.body.length,
      };
      return json(res, { download });
    }

    // 取资源：所有 GET 调用者都只能读取已缓存内容。主应用中的 Markdown、
    // Shadow DOM 与 opaque sandbox 都是不可信内容，Fetch Metadata 不能区分它们；
    // 下载/落盘只能由上面的受保护 JSON POST /api/assets/preload 发起。
    if (method === 'GET' && p === '/api/assets/img') {
      if (AUTH_RUNTIME) {
        req.resume();
        return json(res, { error: '旧资产 URL 通道已关闭', code: 'asset-url-channel-disabled' }, 404);
      }
      const queryKeys = [...url.searchParams.keys()];
      if (
        queryKeys.length !== 1
        || queryKeys[0] !== 'url'
        || url.searchParams.getAll('url').length !== 1
      ) {
        return json(res, { error: '资源请求参数无效', code: 'asset-query-invalid' }, 400);
      }
      const rawUrl = url.searchParams.get('url');
      if (!rawUrl) return json(res, { error: '缺少 url 参数' }, 400);
      const cache = new DiskCache(ASSET_DIR);
      let u: string;
      try {
        u = normalizeUrl(validateSafeFetchUrl(rawUrl, {
          timeoutMs: 30_000,
          maxBytes: MAX_ASSET_DOWNLOAD_BYTES,
          maxRedirects: 3,
        }));
      } catch {
        return json(res, { error: '资源 URL 未通过安全校验', code: 'asset-url-invalid' }, 400);
      }
      const id = assetId(u);
      const buf = cache.get(id);
      if (!buf) {
        return json(res, {
          error: '资源尚未由受保护的预载流程准备',
          code: 'asset-not-prepared',
        }, 409);
      }
      const assetHeaders: Record<string, string | number> = {
        'Content-Type': mimeForUrl(u),
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest',
      };
      if (shouldAllowOpaqueAssetCors({ method, pathname: p, headers: req.headers })) {
        assetHeaders['Access-Control-Allow-Origin'] = 'null';
      }
      res.writeHead(200, assetHeaders);
      res.end(buf);
      return;
    }

    // 清空资源缓存（仅物理删除 + 重置 cached 状态，保留索引）
    if (method === 'POST' && p === '/api/assets/cache/clear') {
      const m = loadManifest(ASSET_DIR);
      const cache = new DiskCache(ASSET_DIR);
      const removed = cache.clear();
      for (const e of m.entries) { e.cached = false; e.bytes = undefined; e.failed = undefined; }
      saveManifest(m, ASSET_DIR);
      return json(res, { ok: true, removed });
    }

    // 服务端代理抓取外部前端页文本（如卡自带 external-page/index.html；浏览器 fetch 跨域受限，由服务器侧解决 CORS）
    if (method === 'POST' && p === '/api/assets/page') {
      if (AUTH_RUNTIME) {
        req.resume();
        return json(res, {
          error: '远程模式暂不返回含源 URL 的外部页面文本',
          code: 'external-page-disabled',
        }, 403);
      }
      const body = await readBody(req);
      const pageUrl = String(body.url ?? '').trim();
      if (!/^https?:\/\//.test(pageUrl)) return json(res, { error: 'url 必须为 http(s)' }, 400);
      try {
        const page = await safeFetchBuffer(pageUrl, {
          timeoutMs: 20_000,
          maxBytes: 2_000_000,
          maxRedirects: 3,
          accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5',
        });
        if (page.status < 200 || page.status >= 300) return json(res, { error: `HTTP ${page.status}` }, 502);
        const contentType = String(page.headers['content-type'] ?? '').toLowerCase();
        if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
          return json(res, { error: '远端内容不是可展示页面' }, 415);
        }
        return json(res, { ok: true, url: page.finalUrl, html: page.body.toString('utf8') });
      } catch {
        return json(res, { error: '页面获取被安全策略拒绝或暂时不可用' }, 502);
      }
    }

    // ── P3 资产工具 ──

    // 正则调试器：测试 findRegex 对输入文本的匹配/替换（P3）
    if (method === 'POST' && p === '/api/regex/test') {
      const body = await readBody(req);
      const pattern = String(body.findRegex ?? '').trim();
      const text = String(body.text ?? '');
      if (!pattern) return json(res, { error: '正则为空' }, 400);
      let re: RegExp;
      try {
        // 支持 /pattern/flags 与纯 pattern 两种格式
        const m = pattern.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
        re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern, 'g');
      } catch (e) {
        return json(res, { error: `正则非法: ${(e as Error).message.slice(0, 60)}` }, 400);
      }
      const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
      const gRe = new RegExp(re.source, flags);
      const matches: { index: number; text: string }[] = [];
      let m2: RegExpExecArray | null;
      let count = 0;
      while ((m2 = gRe.exec(text)) !== null && count < 100) {
        matches.push({ index: m2.index, text: m2[0].slice(0, 60) });
        count++;
        if (m2.index === gRe.lastIndex) gRe.lastIndex++;
      }
      const replaceString = String(body.replaceString ?? '');
      const replaced = replaceString ? text.replace(new RegExp(re.source, flags.includes('g') ? flags : `${flags}g`), replaceString) : undefined;
      return json(res, { matches, count, replaced: replaced !== undefined ? replaced.slice(0, 2000) : undefined });
    }

    // ── 正则库（前端屏蔽隐藏 + 用户维护）──
    // 规则列表（builtin + user + card 合并）
    // FE-06.0：带 `?session=<id>` 时**同时返回有效规则来源诊断**（作者真值按当前卡版本重算）。
    // 不带 session 仍是全局视图（正则库面板用），避免改变既有调用方语义。
    if (method === 'GET' && p === '/api/regex-rules') {
      const urlQ = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const sid = urlQ.searchParams.get('session') ?? '';
      const session = sid ? sessions.get(sid) : null;
      if (!session) return json(res, { rules: regexLibrary.list() });
      const cardName = session.getCardName();
      const cardFile = resolveSessionCardFile(cardName);
      let scripts: ReturnType<typeof parseCharaCard>['regexScripts'] = [];
      let sourceVersion = '';
      if (cardFile) {
        try {
          const parsed = parseCharaCard(readCardText(cardFile)?.raw ?? '');
          scripts = parsed.regexScripts;
          sourceVersion = parsed.cardImport?.contentHash?.slice(0, 12) ?? '';
        } catch { /* 卡解析失败 → 作者真值为空，全部卡规则按"来源无法判定"处理（不自动运行） */ }
      }
      const provenance = regexLibrary.provenance({ scripts, sessionCard: cardName, sourceVersion });
      return json(res, { rules: regexLibrary.list(), provenance, card: { name: cardName, file: cardFile } });
    }

    // 保存/更新规则（builtin 可覆盖启用状态）
    if (method === 'POST' && p === '/api/regex-rules/save') {
      const body = await readBody(req);
      const rule = body.rule && typeof body.rule === 'object' ? body.rule as Record<string, unknown> : null;
      if (!rule || typeof rule.id !== 'string' || typeof rule.findRegex !== 'string') {
        return json(res, { error: '规则缺少 id/findRegex' }, 400);
      }
      const saved = regexLibrary.save({
        id: rule.id,
        name: String(rule.name ?? rule.id),
        findRegex: rule.findRegex,
        replaceString: String(rule.replaceString ?? ''),
        enabled: rule.enabled !== false,
        scope: (rule.scope === 'prompt' || rule.scope === 'both' ? rule.scope : 'display') as 'display' | 'prompt' | 'both',
        source: 'user',
        inject: rule.inject === true,
        note: typeof rule.note === 'string' ? rule.note : undefined,
        order: Number(rule.order ?? 999),
        // FE-06.0：保留来源身份与作者默认（save() 会写入显式覆盖记录 → 来源诊断可判"已授权"）
        sourceCard: typeof rule.sourceCard === 'string' ? rule.sourceCard : undefined,
        sourceVersion: typeof rule.sourceVersion === 'string' ? rule.sourceVersion : undefined,
        authorEnabled: typeof rule.authorEnabled === 'boolean' ? rule.authorEnabled : undefined,
      });
      return json(res, { rule: saved });
    }

    // 删除用户/卡片规则
    if (method === 'POST' && p === '/api/regex-rules/delete') {
      const body = await readBody(req);
      const id = (body.id ?? '').toString();
      const removed = id ? regexLibrary.remove(id) : false;
      return json(res, { ok: true, removed, id });
    }

    // 从角色卡智能导入正则脚本
    if (method === 'POST' && p === '/api/regex-rules/import-card') {
      const body = await readBody(req);
      const cardFile = readAssetReference('card', body.assetId ?? body.card);
      if (!cardFile) {
        return json(res, { error: '角色卡不存在或 assetId 非法' }, 404);
      }
      const cardRes = resolveCard(cardFile);
      if (!cardRes) return json(res, { error: '角色卡不存在或 assetId 非法' }, 404);
      const parsed = parseCharaCard(readCardText(cardFile)?.raw ?? '');
      // FE-06.0：导入时写入来源身份（卡名 + 版本）与作者默认启用状态快照
      const result = regexLibrary.importFromCard(parsed.regexScripts, {
        sourceCard: parsed.card.name,
        sourceVersion: parsed.cardImport?.contentHash?.slice(0, 12) ?? '',
      });
      return json(res, { ok: true, ...result, total: regexLibrary.list().length });
    }

    // ── P8-02 精确流式上传：multipart framing 与临时文件由独立有界 parser 处理。──
    if (method === 'POST' && p === '/api/assets/import') {
      let upload: ReceivedAssetUpload | null = null;
      try {
        upload = await receiveAssetMultipart(req, { tempDir: ASSET_UPLOAD_TEMP_DIR });
        let raw: string;
        let pngBuf: Buffer | null;
        let embeddedWorldbook: LocalAssetImportResult['embeddedWorldbook'];

        try {
          const content = validateAssetContent(upload);
          raw = content.raw;
          pngBuf = content.pngBuffer;
        } catch (error) {
          if (!(error instanceof AssetContentValidationError)) throw error;
          securityAuditSpan?.annotate({ reasonCode: `asset-content-${error.reason}` });
          return json(res, {
            error: `资产内容校验失败: ${error.message.slice(0, 120)}`,
            code: 'asset-content-invalid',
          }, 400);
        }

        if (upload.kind === 'card') {
          let parsed: ReturnType<typeof parseCharaCard>;
          try {
            parsed = parseCharaCard(raw);
          } catch (error) {
            return json(res, {
              error: `角色卡校验失败: ${(error as Error).message.slice(0, 120)}`,
              code: 'asset-content-invalid',
            }, 400);
          }
          if (parsed.worldbookEntries.length > 0) {
            embeddedWorldbook = {
              count: parsed.worldbookEntries.length,
              displayName: parsed.card.data.character_book?.name?.trim() || `${upload.displayName} 世界书`,
            };
          }
        } else {
          try {
            if (upload.kind === 'preset') parsePreset(raw, {});
            else parseWorldBook(raw);
          } catch (error) {
            return json(res, {
              error: `${upload.kind === 'preset' ? '预设' : '世界书'}校验失败: ${(error as Error).message.slice(0, 120)}`,
              code: 'asset-content-invalid',
            }, 400);
          }
        }

        const storageKey = allocateUploadedStorageKey(upload.kind);
        const prepared = ASSET_IMPORT_TRANSACTIONS.prepare({
          kind: upload.kind,
          storageKey,
          displayName: upload.displayName,
          raw,
          pngBuffer: pngBuf,
        });
        const mutation = ASSET_IMPORT_TRANSACTIONS.commit(prepared);
        const identity = mutation.identity;
        if (upload.kind === 'card') sessionCardFileCache.clear();
        eventHub.publish({
          type: 'asset.changed',
          resource: { kind: 'asset', id: `${upload.kind}:${identity.assetId}`, revision: mutation.revision },
          requestId,
        });
        const result: LocalAssetImportResult = {
          assetId: identity.assetId,
          kind: upload.kind,
          displayName: identity.displayName,
          source: 'user',
          revision: mutation.revision,
          format: upload.format,
          bytes: upload.bytes,
          ...(embeddedWorldbook ? { embeddedWorldbook } : {}),
        };
        res.setHeader(REVISION_HEADER, formatStrongEtag(mutation.revision));
        return json(res, result, 201);
      } finally {
        discardAssetUpload(upload);
      }
    }

    // ── 兼容导入/导出（旧客户端 JSON 原文 / 卡片 PNG base64）──
    // 导入大小上限：PNG 角色卡常 >10MB（base64 再 ×4/3），5MB 会误伤真实卡；64MB 覆盖绝大多数
    const MAX_IMPORT = 64 * 1024 * 1024;

    // 角色卡导入（JSON 或 PNG；PNG 自动解包 chara 元数据，强校验后写用户层 data/cards/）
    if (method === 'POST' && p === '/api/card/import') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const filename = (body.filename ?? '').toString().trim();
      const format = body.format === 'png' ? 'png' : 'json';
      const data = (body.data ?? '').toString();
      if (!filename) return json(res, { error: '缺少文件名' }, 400);
      if (!data || data.length > MAX_IMPORT) return json(res, { error: '文件过大或为空' }, 400);
      const name = filename.replace(/\.(json|png)$/i, '');
      if (!name) return json(res, { error: '文件名非法' }, 400);
      let cardJson: string;
      let pngBuf: Buffer | null = null;
      if (format === 'png') {
        pngBuf = Buffer.from(data, 'base64');
        const payload = extractCharaFromPng(pngBuf);
        if (!payload) return json(res, { error: 'PNG 卡无 chara 元数据' }, 400);
        cardJson = pngPayloadToJson(payload);
      } else {
        cardJson = data;
      }
      let parsedCard: ReturnType<typeof parseCharaCard>;
      try {
        parsedCard = parseCharaCard(cardJson);
      } catch (e) {
        return json(res, { error: `角色卡校验失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      const jsonFile = `${name}.json`;
      let mutation: ReturnType<typeof saveUserAssetCas>;
      try {
        mutation = saveUserAssetCas('card', jsonFile, cardJson, expected);
      } catch (error) {
        if (assetConflict(res, error)) return;
        throw error;
      }
      let pngSaved = false;
      if (pngBuf) {
        try {
          saveAssetBuffer('card', `${name}.png`, pngBuf);
          pngSaved = true;
        } catch { /* 规范 JSON 已是完整业务真值；PNG 原件失败不回滚卡片 */ }
      }
      sessionCardFileCache.clear();
      const identity = ensureAssetIdentity('card', jsonFile, parsedCard.card.name || name);
      eventHub.publish({
        type: 'asset.changed',
        resource: { kind: 'asset', id: `card:${identity.assetId}`, revision: mutation.revision },
        requestId,
      });
      // 内嵌世界书检测：供前端弹窗确认是否单独导入世界书库（区分卡与内嵌世界书分别记录）
      const wbEntries = parsedCard.worldbookEntries;
      return revisionJson(res, {
        ok: true, assetId: identity.assetId, file: jsonFile, name, format: 'json', pngSaved,
        embeddedWorldbook: wbEntries.length > 0
          ? { count: wbEntries.length, name: parsedCard.card.data.character_book?.name ?? '' }
          : null,
      }, mutation.revision);
    }

    // 卡片内嵌世界书 → 独立世界书资产（导入卡片后前端弹窗确认调用；同名用户层覆盖=幂等）
    if (method === 'POST' && p === '/api/card/import-worldbook') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const file = readAssetReference('card', body.assetId ?? body.file);
      if (!file || !/\.json$/i.test(file)) {
        return json(res, { error: '需指定已导入的角色卡 JSON 文件' }, 400);
      }
      let raw: string;
      try {
        const card = readCardText(file);
        if (!card) return json(res, { error: '角色卡不存在' }, 404);
        raw = card.raw;
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 120) }, 400);
      }
      let parsed: ReturnType<typeof parseCharaCard>;
      try {
        parsed = parseCharaCard(raw);
      } catch (e) {
        return json(res, { error: `角色卡解析失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      const wbEntries = parsed.worldbookEntries;
      if (wbEntries.length === 0) return json(res, { error: '该角色卡未携带内嵌世界书' }, 400);
      const base = file.replace(/\.json$/i, '');
      const wbName = parsed.card.data.character_book?.name || `${base}-世界书`;
      const wbFile = `${base.replace(/[\\/:*?"<>|]/g, '_')}-世界书.json`;
      let mutation: ReturnType<typeof saveUserAssetCas>;
      try {
        parseWorldBook(JSON.stringify({ name: wbName, entries: wbEntries }, null, 2)); // 强校验后再落盘
        mutation = saveUserAssetCas(
          'worldbook',
          wbFile,
          JSON.stringify({ name: wbName, entries: wbEntries }, null, 2),
          expected,
        );
      } catch (e) {
        if (assetConflict(res, e)) return;
        return json(res, { error: `世界书生成失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      const identity = ensureAssetIdentity('worldbook', wbFile, wbName);
      eventHub.publish({
        type: 'asset.changed',
        resource: { kind: 'asset', id: `worldbook:${identity.assetId}`, revision: mutation.revision },
        requestId,
      });
      return revisionJson(res, {
        ok: true,
        assetId: identity.assetId,
        file: wbFile,
        name: wbName,
        count: wbEntries.length,
      }, mutation.revision);
    }

    // 角色卡删除（仅用户层副本；PNG 卡 .json+.png 同基名一并删除，源资产只读不删）
    if (method === 'POST' && p === '/api/card/delete') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const file = readAssetReference('card', body.assetId ?? body.file);
      if (!file) return json(res, { error: '角色卡引用非法' }, 400);
      try {
        const mutation = deleteUserCardCas(file, expected);
        const identity = ensureAssetIdentity('card', file);
        sessionCardFileCache.clear();
        eventHub.publish({
          type: 'asset.changed',
          resource: { kind: 'asset', id: `card:${identity.assetId}`, revision: mutation.revision },
          requestId,
        });
        return revisionJson(res, {
          ok: true,
          assetId: identity.assetId,
          removed: mutation.removed,
          file,
        }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        return json(res, { error: (error as Error).message.slice(0, 120) }, 400);
      }
    }

    // 角色卡原文导出（JSON / PNG → 角色卡 JSON 文本）
    const cardRawGetRoute = assetRouteReference('card', '/api/card/:file/raw', p);
    if (method === 'GET' && cardRawGetRoute) {
      const file = cardRawGetRoute;
      try {
        const card = readRevisionedCard(file);
        if (!card) return json(res, { error: '角色卡不存在' }, 404);
        const identity = ensureAssetIdentity('card', file);
        return revisionJson(res, {
          assetId: identity.assetId,
          raw: card.raw,
          format: card.format,
          file,
        }, card.revision);
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 120) }, 400);
      }
    }

    // 角色卡导出为酒馆兼容 PNG（PNG 卡直接用原件；JSON 卡动态封装 chara tEXt）
    const cardPngGetRoute = assetRouteReference('card', '/api/card/:file/png', p);
    if (method === 'GET' && cardPngGetRoute) {
      const file = cardPngGetRoute;
      try {
        const src = resolveCard(file);
        if (!src) return json(res, { error: '角色卡不存在' }, 404);
        const card = readRevisionedCard(file);
        if (!card) return json(res, { error: '角色卡读取失败' }, 404);
        const buf = src.format === 'png'
          ? readFileSync(src.path)
          : buildCharaPng(card.raw);
        if (!buf || buf.length === 0) return json(res, { error: '角色卡读取失败' }, 404);
        const identity = ensureAssetIdentity('card', file);
        return revisionJson(res, {
          assetId: identity.assetId,
          data_b64: buf.toString('base64'),
          file,
          pngFile: src.format === 'png' ? (src.path.split(/[\\/]/).pop() ?? '') : `${file.replace(/\.json$/i, '')}.png`,
        }, card.revision);
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 120) }, 400);
      }
    }

    // 预设导入（校验 parsePreset 后写用户层）
    if (method === 'POST' && p === '/api/preset/import') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const filename = (body.filename ?? '').toString().trim();
      const raw = (body.raw ?? '').toString();
      if (!/\.json$/i.test(filename)) return json(res, { error: '文件名需 .json' }, 400);
      if (!raw || raw.length > MAX_IMPORT) return json(res, { error: '文件过大或为空' }, 400);
      try {
        parsePreset(raw, {});
      } catch (e) {
        return json(res, { error: `预设校验失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      try {
        const mutation = saveUserAssetCas('preset', filename, raw, expected);
        const identity = ensureAssetIdentity('preset', filename);
        eventHub.publish({ type: 'asset.changed', resource: { kind: 'asset', id: `preset:${identity.assetId}`, revision: mutation.revision }, requestId });
        return revisionJson(res, { ok: true, assetId: identity.assetId, file: filename }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        throw error;
      }
    }

    // 预设原文导出
    const presetRawGetRoute = assetRouteReference('preset', '/api/preset/:file/raw', p);
    if (method === 'GET' && presetRawGetRoute) {
      const file = presetRawGetRoute;
      const asset = readRevisionedAsset('preset', file);
      if (!asset) return json(res, { error: '预设不存在' }, 404);
      const identity = ensureAssetIdentity('preset', file);
      return revisionJson(res, {
        assetId: identity.assetId,
        raw: asset.raw,
        file,
        source: asset.source,
      }, asset.revision);
    }

    // 世界书导入（校验 parseWorldBook 后写用户层）
    if (method === 'POST' && p === '/api/worldbook/import') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const filename = (body.filename ?? '').toString().trim();
      const raw = (body.raw ?? '').toString();
      if (!/\.json$/i.test(filename)) return json(res, { error: '文件名需 .json' }, 400);
      if (!raw || raw.length > MAX_IMPORT) return json(res, { error: '文件过大或为空' }, 400);
      try {
        parseWorldBook(raw);
      } catch (e) {
        return json(res, { error: `世界书校验失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      try {
        const mutation = saveUserAssetCas('worldbook', filename, raw, expected);
        const identity = ensureAssetIdentity('worldbook', filename);
        eventHub.publish({ type: 'asset.changed', resource: { kind: 'asset', id: `worldbook:${identity.assetId}`, revision: mutation.revision }, requestId });
        return revisionJson(res, { ok: true, assetId: identity.assetId, file: filename }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        throw error;
      }
    }

    // 世界书原文导出
    const worldbookRawGetRoute = assetRouteReference('worldbook', '/api/worldbook/:file/raw', p);
    if (method === 'GET' && worldbookRawGetRoute) {
      const file = worldbookRawGetRoute;
      const asset = readRevisionedAsset('worldbook', file);
      if (!asset) return json(res, { error: '世界书不存在' }, 404);
      const identity = ensureAssetIdentity('worldbook', file);
      return revisionJson(res, {
        assetId: identity.assetId,
        raw: asset.raw,
        file,
        source: asset.source,
      }, asset.revision);
    }

    // ── 资产编辑器（P2 非只读：用户层 data/{presets,worldbooks} 优先于源）──
    // 预设列表（用户层 + 源，source 标记）
    if (method === 'GET' && p === '/api/presets') {
      const listedPresets = listAssets('preset');
      ASSET_IDENTITIES.ensureDiscovered(listedPresets.map((asset) => ({
        kind: 'preset',
        storageKey: asset.file,
        displayName: asset.name,
      })));
      const presets = listedPresets.flatMap((a) => {
        const asset = readRevisionedAsset('preset', a.file);
        if (!asset) return [];
        const identity = ensureAssetIdentity('preset', a.file);
        return [{
          id: a.file,
          assetId: identity.assetId,
          name: identity.displayName,
          source: a.source,
          revision: asset.revision,
        }];
      });
      return json(res, { presets });
    }

    // 预设内容（prompt 块，含全文 content 供编辑器）
    const presetDetailGetRoute = assetRouteReference('preset', '/api/preset/:file', p);
    if (method === 'GET' && presetDetailGetRoute) {
      const file = presetDetailGetRoute;
      const asset = readRevisionedAsset('preset', file);
      if (!asset) return json(res, { error: '预设不存在' }, 404);
      const raw = JSON.parse(asset.raw) as { prompts?: { role?: string; name?: string; enabled?: boolean; content?: string }[]; name?: string };
      const prompts = (raw.prompts ?? []).map((pr, i) => ({
        index: i,
        role: pr.role ?? 'user',
        name: pr.name ?? '',
        enabled: pr.enabled !== false,
        content: pr.content ?? '',
        contentLen: (pr.content ?? '').length,
        preview: (pr.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
      }));
      const identity = ensureAssetIdentity('preset', file, raw.name ?? assetDisplayName(file));
      return revisionJson(res, {
        assetId: identity.assetId,
        name: identity.displayName,
        promptCount: prompts.length,
        prompts,
        source: asset.source,
      }, asset.revision);
    }

    // 预设保存（写用户层 data/presets/<file>；重名=另存为）
    if (method === 'POST' && p === '/api/preset/save') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const file = readAssetReference('preset', body.assetId ?? body.file);
      const prompts = Array.isArray(body.prompts) ? body.prompts as { role?: string; name?: string; enabled?: boolean; content?: string }[] : [];
      if (!file) return json(res, { error: '缺少或无法解析预设引用' }, 400);
      if (prompts.some((x) => typeof x.content !== 'string')) return json(res, { error: 'prompts 缺少 content' }, 400);
      const payload = JSON.stringify({ name: body.name ?? file.replace(/\.json$/, ''), prompts }, null, 2);
      try {
        const mutation = saveUserAssetCas('preset', file, payload, expected);
        const identity = ensureAssetIdentity('preset', file, String(body.name ?? assetDisplayName(file)));
        eventHub.publish({ type: 'asset.changed', resource: { kind: 'asset', id: `preset:${identity.assetId}`, revision: mutation.revision }, requestId });
        return revisionJson(res, {
          ok: true,
          assetId: identity.assetId,
          file,
          path: mutation.path?.replace(process.cwd(), '.') ?? '',
          source: 'user',
          promptCount: prompts.length,
        }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        throw error;
      }
    }

    // 预设删除（仅用户层副本，恢复源）
    if (method === 'POST' && p === '/api/preset/delete') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const file = readAssetReference('preset', body.assetId ?? body.file);
      if (!file) return json(res, { error: '预设引用非法' }, 400);
      try {
        const mutation = deleteUserAssetCas('preset', file, expected);
        const identity = ensureAssetIdentity('preset', file);
        eventHub.publish({ type: 'asset.changed', resource: { kind: 'asset', id: `preset:${identity.assetId}`, revision: mutation.revision }, requestId });
        return revisionJson(res, {
          ok: true,
          assetId: identity.assetId,
          removed: mutation.removed,
          file,
          source: mutation.source ?? null,
        }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        return json(res, { error: (error as Error).message.slice(0, 120) }, 400);
      }
    }

    // 世界书列表（用户层 + 源）
    if (method === 'GET' && p === '/api/worldbooks') {
      const listedWorldbooks = listAssets('worldbook');
      ASSET_IDENTITIES.ensureDiscovered(listedWorldbooks.map((asset) => ({
        kind: 'worldbook',
        storageKey: asset.file,
        displayName: asset.name,
      })));
      const worldbooks = listedWorldbooks.flatMap((a) => {
        const asset = readRevisionedAsset('worldbook', a.file);
        if (!asset) return [];
        const identity = ensureAssetIdentity('worldbook', a.file);
        return [{
          id: a.file,
          assetId: identity.assetId,
          name: identity.displayName,
          source: a.source,
          revision: asset.revision,
        }];
      });
      return json(res, { worldbooks });
    }

    // 世界书全量条目（编辑器）
    const worldbookDetailGetRoute = assetRouteReference('worldbook', '/api/worldbook/:file', p);
    if (method === 'GET' && worldbookDetailGetRoute) {
      const file = worldbookDetailGetRoute;
      const asset = readRevisionedAsset('worldbook', file);
      if (!asset) return json(res, { error: '世界书不存在' }, 404);
      const wb = parseWorldBook(asset.raw);
      const identity = ensureAssetIdentity('worldbook', file);
      return revisionJson(res, {
        assetId: identity.assetId,
        file,
        name: identity.displayName,
        source: asset.source,
        entries: wb.entries.map((e) => ({
          uid: String(e.uid ?? ''),
          key: e.key ?? [],
          comment: e.comment ?? '',
          content: e.content ?? '',
          constant: Boolean(e.constant),
          selective: Boolean(e.selective),
          use_regex: Boolean(e.use_regex),
          triggers: e.triggers ?? [],
          probability: Number(e.extensions?.probability ?? e.probability ?? 100),
          useProbability: Boolean(e.extensions?.useProbability ?? e.useProbability ?? false),
          active: !e.disable,
          depth: e.depth ?? 0,
        })),
      }, asset.revision);
    }

    // 世界书保存（写用户层 data/worldbooks/<file>，ST v1.12 entries 格式）
    if (method === 'POST' && p === '/api/worldbook/save') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const file = readAssetReference('worldbook', body.assetId ?? body.file);
      const entries = Array.isArray(body.entries) ? body.entries as Record<string, unknown>[] : [];
      if (!file) return json(res, { error: '缺少或无法解析世界书引用' }, 400);
      const record: Record<string, unknown> = {};
      for (const e of entries) {
        const uid = String(e.uid ?? `e${Object.keys(record).length + 1}`);
        const { uid: _uid, ...rest } = e;
        record[uid] = { ...rest, uid: Number(uid) || uid };
      }
      const payload = JSON.stringify({ entries: record }, null, 2);
      try {
        const mutation = saveUserAssetCas('worldbook', file, payload, expected);
        const identity = ensureAssetIdentity('worldbook', file);
        eventHub.publish({ type: 'asset.changed', resource: { kind: 'asset', id: `worldbook:${identity.assetId}`, revision: mutation.revision }, requestId });
        return revisionJson(res, {
          ok: true,
          assetId: identity.assetId,
          file,
          path: mutation.path?.replace(process.cwd(), '.') ?? '',
          source: 'user',
          count: entries.length,
        }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        throw error;
      }
    }

    // 世界书删除（仅用户层副本）
    if (method === 'POST' && p === '/api/worldbook/delete') {
      const expected = expectedRevision(req, res);
      if (expected === null) return;
      const body = await readBody(req);
      const file = readAssetReference('worldbook', body.assetId ?? body.file);
      if (!file) return json(res, { error: '世界书引用非法' }, 400);
      try {
        // force=新建会话列表的全量删除（一次删除当前可见层）；不带 force=恢复源文件。
        const mutation = body.force === true
          ? deleteWorldbookFileCas(file, expected)
          : { ...deleteUserAssetCas('worldbook', file, expected), layer: 'user' as const };
        const identity = ensureAssetIdentity('worldbook', file);
        eventHub.publish({ type: 'asset.changed', resource: { kind: 'asset', id: `worldbook:${identity.assetId}`, revision: mutation.revision }, requestId });
        return revisionJson(res, {
          ok: true,
          assetId: identity.assetId,
          removed: mutation.removed,
          layer: mutation.layer,
          file,
          source: mutation.source ?? null,
        }, mutation.revision);
      } catch (error) {
        if (assetConflict(res, error)) return;
        return json(res, { error: (error as Error).message.slice(0, 120) }, 400);
      }
    }

    // 会话内世界书条目浏览（lorebook_entry）
    const lorebookEntriesGetRoute = matchRouteTemplate('/api/session/:sessionId/lorebook-entries', p);
    if (method === 'GET' && lorebookEntriesGetRoute) {
      const id = lorebookEntriesGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const mem = (session as unknown as { getMemory(): { mem: { db: import('node:sqlite').DatabaseSync } } }).getMemory().mem.db;
      const rows = mem.prepare('SELECT id, book, comment, key, content, use_regex, probability, active FROM lorebook_entry ORDER BY id LIMIT 300').all() as {
        id: number; book: string; comment: string; key: string; content: string; use_regex: number; probability: number; active: number;
      }[];
      return json(res, {
        entries: rows.map((r) => ({
          id: r.id, book: r.book, comment: r.comment, key: r.key, useRegex: r.use_regex === 1,
          probability: r.probability, active: r.active === 1, preview: r.content.replace(/\s+/g, ' ').slice(0, 60),
        })),
        count: rows.length,
      });
    }

    // ── Skill 系统（公共格式 data/skills/<name>/SKILL.md）──
    if (method === 'GET' && p === '/api/skills') {
      const { listSkills } = await import('../../packages/core/src/skills.ts');
      return json(res, { skills: listSkills() });
    }
    if (method === 'POST' && p === '/api/skills/match') {
      const { matchSkills } = await import('../../packages/core/src/skills.ts');
      const body = await readBody(req);
      const query = String(body.query ?? '').trim();
      if (!query) return json(res, { matched: [] });
      return json(res, { matched: matchSkills(query).map((m) => ({ name: m.skill.name, score: Number(m.score.toFixed(3)), body: m.body.slice(0, 200) })) });
    }
    if (method === 'POST' && p === '/api/skills/add') {
      const { addSkill } = await import('../../packages/core/src/skills.ts');
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const description = String(body.description ?? '').trim();
      const content = String(body.content ?? '').trim();
      const keywords = Array.isArray(body.keywords)
        ? (body.keywords as string[]).map((s) => String(s).trim()).filter(Boolean)
        : String(body.keywords ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (!name || !content) return json(res, { error: '技能名与指令正文不能为空' }, 400);
      try {
        const skill = addSkill({ name, description, content, keywords });
        return json(res, { ok: true, skill: { name: skill.name, description: skill.description, keywords: skill.keywords, enabled: skill.enabled } });
      } catch (e) {
        return json(res, { error: (e as Error).message }, 400);
      }
    }
    if (method === 'POST' && p === '/api/skills/import-style') {
      // 文风库 → 文风 skill（幂等；源内容不变则跳过）
      const { importStyleBooks } = await import('../../tools/cli/import-style.ts');
      try {
        const r = importStyleBooks();
        return json(res, { ok: true, created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length, total: r.total });
      } catch (e) {
        return json(res, { error: `文风库导入失败: ${(e as Error).message}` }, 400);
      }
    }
    const skillsActionPostRoute = matchRouteTemplate('/api/skills/:name/:action', p);
    if (method === 'POST' && skillsActionPostRoute) {
      const { setSkillEnabled, deleteSkill } = await import('../../packages/core/src/skills.ts');
      let name: string;
      try {
        name = decodeURIComponent(skillsActionPostRoute.name);
      } catch {
        return json(res, { error: '技能名编码非法' }, 400);
      }
      const action = skillsActionPostRoute.action;
      try {
        if (action === 'enable') return json(res, { ok: true, skill: setSkillEnabled(name, true) });
        if (action === 'disable') return json(res, { ok: true, skill: setSkillEnabled(name, false) });
        if (action === 'delete') { deleteSkill(name); return json(res, { ok: true }); }
        return json(res, { error: `未知操作: ${action}` }, 400);
      } catch (e) {
        return json(res, { error: (e as Error).message }, 404);
      }
    }

    // ── 导演分镜（第三个创作选项，Commit B 前端入口）──
    // 工作流列表 + 默认导演之声池
    if (method === 'GET' && p === '/api/storyboard/workflows') {
      try {
        const registry = new StoryboardRegistry();
        const workflows = registry.list();
        const voices = workflows.includes(DEFAULT_WORKFLOW) ? registry.get(DEFAULT_WORKFLOW).voices : [];
        return json(res, { workflows, defaultWorkflow: DEFAULT_WORKFLOW, voices });
      } catch (e) {
        return json(res, { error: `工作流注册表不可用: ${(e as Error).message.slice(0, 120)}` }, 500);
      }
    }

    // 执行分镜（SSE：stage 阶段进度 → done 结果摘要）
    if (method === 'POST' && p === '/api/storyboard/run') {
      const body = await readBody(req);
      const scene = (body.scene ?? '').toString().trim();
      if (!scene) return json(res, { error: '场景描述为空' }, 400);
      sse(res);
      try {
        const cfg = (await import('../../packages/proxy/src/config.ts')).loadProviderConfig();
        const providerClient = providerClientForServer();
        if (!providerClient) (await import('../../packages/proxy/src/config.ts')).assertProviderReady(cfg);
        const mem = new MemoryDb({ path: resolve(DATA_DIR, `storyboard-${Date.now()}.db`) });
        const ret = new RetrievalEngine(mem);
        try {
          ret.setEmbeddingProvider(await createEmbeddingProvider(true));
        } catch {
          ret.setEmbeddingProvider(new HashEmbeddingProvider());
        }
        const orch = new StoryboardOrchestrator({
          client: observeServerModelClient(providerClient ?? new OpenAICompatibleClient(cfg)),
          ret,
          scanner: new LorebookScanner(mem),
          vms: new VariableManager(),
          mem,
          cardName: '导演分镜',
          round: 1,
          signal: requestAbortController?.signal,
        });
        const result = await orch.run(
          scene,
          {
            mode: body.mode === 'shot' ? 'shot' : 'batch',
            shotCount: Math.min(30, Math.max(1, Number(body.shots ?? 3))),
            workflow: typeof body.workflow === 'string' && body.workflow ? body.workflow : undefined,
            voice: typeof body.voice === 'string' && body.voice ? body.voice : undefined,
          },
          (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }),
        );
        sseSend(res, storyboardDonePayload(result, { sceneName: `分镜「${scene.slice(0, 20)}」` }));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // ── 导演模式（对话内选区触发：选中文本 → 复用会话真实记忆/世界书/变量跑分镜管线，SSE 阶段进度 + done）
    // 与 /api/storyboard/run 同引擎，但上下文来自本会话（非空库）；结果落 memory_state(storyboard) 可检索 + 探窗展示/下载
    const directorPostRoute = matchRouteTemplate('/api/session/:sessionId/director', p);
    if (method === 'POST' && directorPostRoute) {
      const id = directorPostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const selectedText = (body.selectedText ?? '').toString().trim();
      if (!selectedText) return json(res, { error: '选中文本为空' }, 400);
      sse(res);
      try {
        const result = await session.directorRun({
          selectedText,
          round: Number(body.round) || undefined,
          role: typeof body.role === 'string' ? body.role : undefined,
          messageId: Number(body.messageId) || undefined,
          shots: Number(body.shots) || undefined,
          voice: typeof body.voice === 'string' && body.voice ? body.voice : undefined,
          workflow: typeof body.workflow === 'string' && body.workflow ? body.workflow : undefined,
        }, (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }), requestAbortController?.signal);
        sseSend(res, storyboardDonePayload(result, {
          sceneName: `导演分镜「${selectedText.slice(0, 10)}…」`,
          directorSource: selectedText.slice(0, 120),
        }));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // ── H3 视频提示词（分镜完成后按需旁路：会话模式走会话上下文提取对白，独立页走场景描述；panels 由前端回传）──
    const directorVideoPromptPostRoute = matchRouteTemplate('/api/session/:sessionId/director/video-prompt', p);
    if (method === 'POST' && directorVideoPromptPostRoute) {
      const id = directorVideoPromptPostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const panels = parseVideoPromptPanels(body.panels);
      if (!panels.length) return json(res, { error: 'panels 为空或非法' }, 400);
      sse(res);
      try {
        const result = await session.videoPromptRun({
          panels,
          sequenceSfx: typeof body.sequenceSfx === 'string' ? body.sequenceSfx : undefined,
          selectedText: typeof body.selectedText === 'string' ? body.selectedText : undefined,
          round: Number(body.round) || undefined,
        }, (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }), requestAbortController?.signal);
        sseSend(res, videoPromptDonePayload(result));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // 独立页模式（无会话上下文：scene 作对白提取源；一次性客户端不落库）
    if (method === 'POST' && p === '/api/storyboard/video-prompt') {
      const body = await readBody(req);
      const panels = parseVideoPromptPanels(body.panels);
      if (!panels.length) return json(res, { error: 'panels 为空或非法' }, 400);
      const scene = (body.scene ?? '').toString().trim();
      if (!scene) return json(res, { error: '场景描述为空' }, 400);
      sse(res);
      try {
        const cfg = loadProviderConfig();
        const providerClient = providerClientForServer();
        if (!providerClient) assertProviderReady(cfg);
        const gen = new VideoPromptGenerator({
          client: observeServerModelClient(providerClient ?? new OpenAICompatibleClient(cfg)),
          cardName: '导演分镜',
          round: 1,
          signal: requestAbortController?.signal,
        });
        const result = await gen.run(panels, { sequenceSfx: typeof body.sequenceSfx === 'string' ? body.sequenceSfx : undefined, dialogueSource: scene },
          (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }));
        sseSend(res, videoPromptDonePayload(result));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // AQL 质量报表（半自动闭环：遥测归因 + 改进建议；只读）
    if (method === 'GET' && p === '/api/quality/report') {
      const files = scanSessionDbs(DATA_DIR);
      const reports = files
        .map((f) => {
          try { return analyzeQualityDb(f); } catch { return null; }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.rounds > 0);
      return json(res, { reports, minSample: Number(process.env.JG_QUALITY_MIN_SAMPLE ?? 5) });
    }

    // AQL 自适应覆盖：读 / 写 adaptive-config（半自动；POST 后对全部活动会话 refreshAdaptive 即时生效，可回滚）
    if (p === '/api/quality/overrides') {
      if (method === 'GET') return json(res, { config: readAdaptiveConfig() });
      if (method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        if (body.reset === true) {
          writeAdaptiveConfig({});
        } else {
          const cfg = readAdaptiveConfig();
          const patch = (body.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<string, unknown>;
          const next: Parameters<typeof writeAdaptiveConfig>[0] = {
            retrieval: { ...(cfg.retrieval ?? {}), ...(patch.retrieval as object | undefined) },
            archive: { ...(cfg.archive ?? {}), ...(patch.archive as object | undefined) },
            summary: { ...(cfg.summary ?? {}), ...(patch.summary as object | undefined) },
            replan: { ...(cfg.replan ?? {}), ...(patch.replan as object | undefined) },
            meta: { ...(cfg.meta ?? {}), updatedAt: new Date().toISOString(), note: 'overrides API 更新' },
          };
          writeAdaptiveConfig(next);
        }
        for (const s of sessions.values()) {
          try { s.refreshAdaptive(); } catch { /* 会话异常忽略 */ }
        }
        return json(res, { ok: true, config: readAdaptiveConfig() });
      }
    }

    // 健康检查
    if (method === 'GET' && p === '/api/health') {
      return json(res, { ok: true, sessions: sessions.size });
    }

    securityAuditSpan?.annotate({ reasonCode: 'route-not-found' });
    return json(res, { error: '请求的路由不存在', code: 'route-not-found', requestId }, 404);
  } catch (e) {
    if (e instanceof AssetUploadError) {
      securityAuditSpan?.annotate({ reasonCode: e.code });
      return json(res, { error: e.message, code: e.code }, e.status);
    }
    if (e instanceof PayloadTooLargeError) {
      securityAuditSpan?.annotate({ reasonCode: 'payload-too-large' });
      return json(res, { error: '请求体过大', code: 'payload-too-large' }, 413);
    }
    securityAuditSpan?.annotate({ reasonCode: 'internal-error' });
    return json(res, { error: '服务器内部错误', code: 'internal-error' }, 500);
  }
});

// 端口占用兜底（初始化审查修复 #2）：EADDRINUSE 时给出明确中文指引后退出，
// 避免裸抛堆栈「黑窗口一闪就退」用户无从排查
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[web-api] 启动失败：端口 ${PORT} 已被占用。`);
    console.error('[web-api] 原因：上次的 server 进程未退出（或残留孤儿 node 进程占着端口）。');
    console.error('[web-api] 处理：先双击 停止.bat（或任务管理器结束残留 node.exe），再重新启动；');
    console.error('[web-api]        或设置环境变量换端口，例如：JG_WEB_PORT=18000 pnpm web:server');
    process.exit(1);
  }
  throw e;
});

let shuttingDown = false;
let startPromise: Promise<void>;
async function startWebServer(): Promise<void> {
  // 插件完成原子激活（或明确失败）后再接流量，避免启动窗口内行为随机。
  const loadResults = await dshHost.loadAll(pluginRegistry.list(), (rec) => resolve(PLUGINS_DIR, rec.name));
  for (const result of loadResults) {
    if (result.status === 'failed') dshRuntimeErrors.set(result.id, result.error ?? '加载失败');
    else dshRuntimeErrors.delete(result.id);
  }
  const commandCodeRecord = pluginRegistry.get(COMMANDCODE_PROVIDER_PLUGIN_ID);
  if (commandCodeRecord?.enabled && commandCodeRecord.kind === 'dsh') {
    const commandCodeLoad = loadResults.find((result) => result.id === COMMANDCODE_PROVIDER_PLUGIN_ID);
    if (commandCodeLoad?.status !== 'active') {
      throw new Error(
        `First-party CommandCode Provider activation failed: ${commandCodeLoad?.error ?? 'missing load result'}`,
      );
    }
  }
  await turnJobs.recoverAvailable();
  maintenanceHarness!.recoverExpired();
  maintenanceHarness!.setMode('shadow');
  // 宿主环境只是能力上限；持久 global kill switch 不因重启被偷偷打开。
  if (!MAINTENANCE_RUNTIME.enabled) maintenanceHarness!.setGlobalEnabled(false);
  if (MAINTENANCE_RUNTIME.enabled && maintenanceJobs.globalEnabled()) {
    queueMicrotask(() => { void maintenanceHarness?.drainAvailable(2); });
  }
  if (shuttingDown) return;
  server.listen(PORT, HOST, () => {
    console.log(`[web-api] http://${HOST}:${PORT}`);
    console.log(`[web-api] GET /api/cards | POST /api/session/new(SSE) | POST /api/turn(SSE)`);
  });
}
startPromise = startWebServer().catch((error) => {
  console.error(`[web-api] 启动失败: ${(error as Error).message.slice(0, 200)}`);
  process.exitCode = 1;
});

/** DSH 插件生命周期联动：安装/启停/更新/卸载后重载对应实例（先卸旧再装新，幂等） */
async function reloadDshPlugin(id: string): Promise<void> {
  const rec = pluginRegistry.get(id);
  await dshHost.unload(id);
  if (!rec || !rec.enabled || rec.kind !== 'dsh') {
    dshRuntimeErrors.delete(id);
    return;
  }
  try {
    await dshHost.load(rec, resolve(PLUGINS_DIR, rec.name));
    dshRuntimeErrors.delete(id);
  } catch (error) {
    dshRuntimeErrors.set(id, (error as Error).message.slice(0, 160));
    throw error;
  }
}

async function shutdownWebServer(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[web-api] 收到 ${signal}，正在 drain DSH 插件...`);
  const closePromise = server.listening
    ? new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    : Promise.resolve();
  await pluginMutationTail;
  await maintenanceHarness?.close();
  await turnJobs.close();
  INTERACTIVE_CALL_LEDGER?.close();
  MODEL_USAGE_LEDGER.close();
  AGENT_ADMISSION_LEDGER?.close();
  AGENT_LEARNING_LEDGER?.close();
  ARC_PROJECTIONS?.close();
  WORLDBOOK_REPAIR_CONTROL?.close();
  AGENT_CONTROL_STORE.close();
  await providerRegistry.clear();
  await dshHost.dispose();
  await startPromise;
  await closePromise;
  SERVER_PROCESS_LOCK.release();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdownWebServer(signal).then(
      () => { process.exitCode = 0; },
      (error) => {
        console.error(`[web-api] 关闭失败: ${(error as Error).message.slice(0, 160)}`);
        process.exitCode = 1;
      },
    );
  });
}
