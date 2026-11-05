import { createSessionProviderRuntime } from './session-provider-runtime.ts';
import { createSchemaRepairAdmittedDispatcher, createSchemaRepairContextReader } from './schema-repair-admission.ts';
import { createContextCompilerSessionHost } from './context-compiler-session-host.ts';
import { recoverSessionEffectWatch } from './effect-watch-recovery.ts';
import { ContextCompilerShadowRunner, buildContextCompilerShadowRequest } from './context-compiler-shadow-runner.ts';
import { ContextCompilerCanarySamples } from './context-compiler-canary.ts';
import { estimateTokens } from '../../packages/prompt/public/assembly.ts';
import { createWorldbookApplyEvidenceScheduler, hasRetainedWorldbookApplyEvidence } from './skill-hub/worldbook-apply-evidence.ts';
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
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, existsSync, readFileSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTurnOperationHost } from './turn-operation-host.ts';
import type { TurnOperationPhase } from './turn-operation-runtime.ts';
import { AgentSkillConsumptionOutbox } from '../../packages/memory/public/agent-skill-consumption-outbox.ts';
import { createToolResultBodyAccess, parseToolResultBodyRead } from './tool-result-body-access.ts';
import { createContextCompilerSkillLiveCall } from './skill-hub/context-compiler-live.ts';
import { createSkillFulfillmentSessionHost } from './skill-fulfillment-session-host.ts';
import { CONTEXT_COMPILER_INPUT_VERSION, parseContextCompilerInput, contextCompilerInputManifest }
  from '../../packages/agent-policy/public/context-compiler-input.ts';
import { agentSkillLiveEnabled } from './skill-hub/live-request.ts';
import {
  createLearningPreferenceSkillLiveCall, createLearningPreferenceSkillDispatchAuthority,
  learningPreferenceSkillLiveEnabled,
  learningPreferenceSkillPolicyAllowed,
} from './skill-hub/learning-preference-live.ts';
import {
  captureLearningPreferenceSkillSource, createLearningPreferenceSkillSourceAuthority,
} from './skill-hub/learning-preference-context.ts';
import { createLearningPreferenceSkillSourceCommitAuthority }
  from './skill-hub/learning-preference-source-commit.ts';
import { createLearningPreferenceSkillSourceScheduler } from './skill-hub/learning-preference-source-reconciler.ts';
import { openLearningPreferenceSkillSourceRecovery } from './learning-preference-source-recovery.ts';
import {
  createBranchPreferenceSkillLiveCall, createBranchPreferenceSkillDispatchAuthority,
  branchPreferenceSkillLiveEnabled, branchPreferenceSkillPolicyAllowed,
} from './skill-hub/branch-preference-live.ts';
import {
  captureBranchPreferenceSkillSource, createBranchPreferenceSkillSourceAuthority,
} from './skill-hub/branch-preference-context.ts';
import { createBranchPreferenceSkillSourceCommitAuthority }
  from './skill-hub/branch-preference-source-commit.ts';
import { captureStyleCompileSkillSource, isStyleCompileSkillSourceCurrent,
  type StyleCompileSkillSourceSnapshotV1 } from './skill-hub/style-compile-context.ts';
import { createStyleCompileSkillLiveCall, styleCompileSkillLiveEnabled,
  styleCompileSkillPolicyAllowed } from './skill-hub/style-compile-live.ts';
import { createStyleCompileSkillHostAuthority } from './skill-hub/style-compile-host-authority.ts';
import { commitStyleCompileSkillSourceReceipt, commitStyleCompileSkillAdoption } from './style-compile-skill-source.ts';
import { AGENT_EVIDENCE_DB_FILE, AgentEvidenceLedger } from './agent-evidence-ledger.ts';
import { openAgentEvidenceRuntime } from './agent-evidence-runtime.ts';
import { openAgentSkillCandidateRuntime, candidateSubmissionsEnabled } from './skill-hub/candidate-runtime.ts';
import { openSkillCompileRuntime, skillCompileEnabled } from './skill-hub/skill-compile-runtime.ts';
import { SKILL_COMPILE_DB_FILE } from './skill-compile-store.ts';
import { submitSkillCompile, readSkillCompile } from './skill-compile-api.ts';
import { SKILL_COMPILE_POLICY_VERSION } from './skill-compile-model.ts';
import { openSkillEvaluateRuntime, skillEvaluateEnabled } from './skill-hub/skill-evaluate-runtime.ts';
import { SKILL_EVALUATE_DB_FILE } from './skill-evaluate-store.ts';
import { SKILL_EVALUATE_POLICY_VERSION } from './skill-evaluate-model.ts';
import { createSkillEvaluatePlan } from './skill-evaluate-registry.ts';
import { submitSkillEvaluate, readSkillEvaluate } from './skill-evaluate-api.ts';
import {
    openSkillSampleRuntime, skillSampleEnabled, skillSampleSuiteEnabled, type SkillSampleQualityInput,
} from './skill-hub/skill-sample-runtime.ts';
import {
    CandidateEvaluationSampleHost,
    candidateEvaluationCompletedSourceIdentityCurrent,
    candidateEvaluationSampleSourceFromCurrent,
} from './skill-hub/candidate-evaluation-sample-host.ts';
import { SKILL_SAMPLE_DB_FILE } from './skill-sample-store.ts';
import { SKILL_SAMPLE_POLICY_VERSION } from './skill-sample-model.ts';
import { createSkillSamplePlan } from './skill-sample-registry.ts';
import {
    submitSkillSample, readSkillSample, submitSkillSampleSuite, readSkillSampleSuite,
} from './skill-sample-api.ts';
import { openSkillQualityRuntime } from './skill-hub/skill-quality-runtime.ts';
import { SKILL_QUALITY_DB_FILE } from './skill-quality-store.ts';
import { SKILL_QUALITY_POLICY_VERSION } from './skill-quality-model.ts';
import {
    resolveSkillQualityAuthority, skillQualityEnabled,
} from './skill-quality-authority.ts';
import { submitSkillQualitySuite, readSkillQualitySuite } from './skill-quality-api.ts';
import { openSkillPromotionRuntime } from './skill-hub/skill-promotion-runtime.ts';
import { readAdmissionDecisionsApi, ADMISSION_DECISIONS_ROUTE } from './admission-decisions-api.ts';
import {
    CandidateEvaluationBatchStore, CANDIDATE_EVALUATION_BATCH_DB_FILE,
} from './candidate-evaluation-batch-store.ts';
import {
    readSkillPromotionPreflightApi, promoteSkillCandidateApi, retireSkillCandidateApi, adoptSkillCandidateApi,
    readSkillChannelApi, readSkillChannelEvidenceApi, readSkillPromotionOverviewApi, reconcileSkillRetirementsApi,
    readSkillCandidateDiffApi, listSkillPromotionEvidenceApi, SKILL_PROMOTION_ROUTE_TEMPLATES,
} from './skill-promotion-api.ts';
import { createSkillOperationalSource } from './skill-hub/skill-operational-source.ts';
import { listSkillOperationalSources, readSkillOperationalSource } from './skill-operational-source-api.ts';
import { openExplicitPreferenceEvidenceSource } from './explicit-preference-evidence-source.ts';
import { createExplicitPreferenceEvidenceScheduler } from './skill-hub/explicit-preference-evidence.ts';
import { openClosureSkillEvidenceSource } from './closure-skill-evidence-source.ts';
import { createClosureSkillEvidenceScheduler } from './skill-hub/closure-skill-evidence.ts';
import { openMaintenanceMemoryEvidenceSource } from './maintenance-memory-evidence-source.ts';
import { createMaintenanceMemoryEvidenceScheduler } from './skill-hub/maintenance-memory-evidence.ts';
import { openMaintenanceSummaryEvidenceSource } from './maintenance-summary-evidence-source.ts';
import { createMaintenanceSummaryEvidenceScheduler } from './skill-hub/maintenance-summary-evidence.ts';
import { createMaintenanceProposalRejectionEvidenceScheduler, maintenanceProposalRejectionEvidenceRecord }
  from './skill-hub/maintenance-proposal-rejection-evidence.ts';
import { createMaintenanceProposalApprovalEvidenceScheduler, maintenanceProposalApprovalEvidenceRecord }
  from './skill-hub/maintenance-proposal-approval-evidence.ts';
import { createRegenerationEvidenceScheduler } from './skill-hub/regeneration-evidence.ts';
import { createStyleCompileAdoptionEvidenceScheduler, hasRetainedStyleCompileAdoptionEvidence,
  readStyleCompileAdoptionEvidencePage }
  from './skill-hub/style-compile-adoption-evidence.ts';
import { createVariableApplyEvidenceScheduler, hasRetainedVariableApplyEvidence, readVariableApplyEvidencePage }
  from './skill-hub/variable-apply-evidence.ts';
import { readVariableApplyEvidencePageV2 } from './skill-hub/variable-apply-outcome.ts';
import { createReportedEffectEvidenceScheduler, hasRetainedReportedEffects } from './skill-hub/reported-effect-evidence.ts';
import { createBranchModifiedEvidenceScheduler, hasRetainedBranchModifiedEvidence } from './skill-hub/branch-modified-evidence.ts';
import { createVariableInvalidationEvidenceScheduler, hasRetainedVariableInvalidationEvidence } from './skill-hub/variable-invalidation-evidence.ts';
import { createBranchAttributionEvidenceScheduler, hasRetainedBranchAttributionEvidence } from './skill-hub/branch-attribution-evidence.ts';
import { createPreferenceInferenceEvidenceScheduler, hasRetainedPreferenceInferenceEvidence } from './skill-hub/preference-inference-evidence.ts';
import { createAqlAdvisoryEvidenceScheduler, hasRetainedAqlAdvisoryEvidence } from './skill-hub/aql-advisory-evidence.ts';
import { createNsfwSceneEvidenceScheduler, hasRetainedNsfwSceneEvidence } from './skill-hub/nsfw-scene-evidence.ts';
import { createArcCommitEvidenceScheduler, hasRetainedArcCommitEvidence } from './skill-hub/arc-commit-evidence.ts';
import { createNpcOperationEvidenceScheduler, hasRetainedNpcOperationEvidence } from './skill-hub/npc-operation-evidence.ts';
import { openRegenerationEvidenceSource, hasRetainedRegenerationEvidence } from './regeneration-evidence-source.ts';
import { CRITIC_SKILL_POLICY_VERSION, criticSkillLiveEnabled, createCriticSkillLiveCall } from './skill-hub/critic-live.ts';
import { createForegroundSkillHostAuthority } from './skill-hub/foreground-host-authority.ts';
import { createPreludeSkillLiveCall, preludeSkillLiveEnabled, preludeSkillPolicyAllowed } from './skill-hub/prelude-live.ts';
import { createVariableProposalSkillLiveCall, variableProposalSkillLiveEnabled,
  variableProposalSkillPolicyAllowed } from './skill-hub/variable-proposal-live.ts';
import { buildVariableProposalSkillRequest, parseVariableProposalSkillOutput }
  from '../../packages/agent-policy/public/variable-proposal-skill.ts';
import { createAgentSkillConsumptionScheduler } from './skill-hub/consumption-scheduler.ts';
import { captureMaintenanceMemorySkillSource } from './skill-hub/maintenance-memory-context.ts';
import { createMaintenanceMemorySkillHostAuthority } from './skill-hub/maintenance-memory-host-authority.ts';
import { createMaintenanceMemorySkillLiveCall, bindMaintenanceMemorySkillLifecycle,
  maintenanceMemorySkillLiveEnabled, maintenanceMemorySkillPolicyAllowed } from './skill-hub/maintenance-memory-live.ts';
import { captureMaintenanceSummarySkillSource } from './skill-hub/maintenance-summary-context.ts';
import { createMaintenanceSummarySkillHostAuthority } from './skill-hub/maintenance-summary-host-authority.ts';
import {
  createMaintenanceSummarySkillLiveCall, bindMaintenanceSummarySkillLifecycle,
  maintenanceSummarySkillLiveEnabled, maintenanceSummarySkillPolicyAllowed,
} from './skill-hub/maintenance-summary-live.ts';
import { captureMaintenanceArcSkillSource } from './skill-hub/maintenance-arc-context.ts';
import { createMaintenanceArcSkillHostAuthority } from './skill-hub/maintenance-arc-host-authority.ts';
import { createMaintenanceArcSkillLiveCall, bindMaintenanceArcSkillLifecycle,
  maintenanceArcSkillLiveEnabled, maintenanceArcSkillPolicyAllowed } from './skill-hub/maintenance-arc-live.ts';
import { captureMaintenanceNpcSkillSource } from './skill-hub/maintenance-npc-context.ts';
import { createMaintenanceNpcSkillHostAuthority } from './skill-hub/maintenance-npc-host-authority.ts';
import { createMaintenanceNpcSkillLiveCall, bindMaintenanceNpcSkillLifecycle,
  maintenanceNpcSkillLiveEnabled, maintenanceNpcSkillPolicyAllowed } from './skill-hub/maintenance-npc-live.ts';
import { captureMaintenanceWorldbookSkillSource } from './skill-hub/maintenance-worldbook-context.ts';
import { createNsfwSceneSkillHost, nsfwSceneSkillLiveEnabled } from './skill-hub/nsfw-scene-host.ts';
import { nsfwSceneRequestDigest } from '../../packages/session/public/nsfw-scene-request.ts';
import { createMaintenanceWorldbookSkillHostAuthority } from './skill-hub/maintenance-worldbook-host-authority.ts';
import { createMaintenanceWorldbookSkillLiveCall, bindMaintenanceWorldbookSkillLifecycle,
  maintenanceWorldbookSkillLiveEnabled, maintenanceWorldbookSkillPolicyAllowed } from './skill-hub/maintenance-worldbook-live.ts';
import { maintenanceModelModeAllowed } from './maintenance-model-mode-policy.ts';
import { createMaintenanceMemorySkillProposalScheduler } from './skill-hub/maintenance-memory-proposal-reconciler.ts';
import { createMaintenanceMemoryWriteScheduler,
  withMaintenanceMemoryWriteWake } from './skill-hub/maintenance-memory-write-reconciler.ts';
import { createMaintenanceSummaryWriteScheduler,
  withMaintenanceSummaryWriteWake } from './skill-hub/maintenance-summary-write-reconciler.ts';
import { openMaintenanceMemoryWriteRecovery,
  openMaintenanceMemoryConsumptionRecovery,
  openMaintenanceSummaryWriteRecovery,
  openMaintenanceSummaryConsumptionRecovery } from './maintenance-memory-write-recovery.ts';
import { MaintenanceMemoryConsumptionAuthority } from './skill-hub/maintenance-memory-consumption-authority.ts';
import { MaintenanceSummaryConsumptionAuthority } from './skill-hub/maintenance-summary-consumption-authority.ts';
import { createMaintenanceMemoryConsumptionScheduler }
  from './skill-hub/maintenance-memory-consumption-reconciler.ts';
import { createMaintenanceSummaryConsumptionScheduler }
  from './skill-hub/maintenance-summary-consumption-reconciler.ts';
import { assertMaintenanceMemoryDirectWriteAllowed } from './maintenance-memory-direct-write.ts';
import { assertMaintenanceSummaryDirectWriteAllowed } from './maintenance-summary-direct-write.ts';
import {
  ChatSession,
  StoryIndexGenerationUnavailableError,
} from '../../packages/session/src/session.ts';
import type {
  BranchSelectionReference,
  ImageAttachment,
  SessionArgs,
} from '../../packages/session/src/session.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { getPgVectorStore } from '../../packages/memory/public/db.ts';
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
  deleteUserAssetOverrideCas,
  deleteUserAssetCas,
  deleteUserCardCas,
  deleteWorldbookFileCas,
  listAssets,
  listCards,
  readAsset,
  readCardText,
  readRevisionedAsset,
  readRevisionedAssetLayer,
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
import { StoryboardOrchestrator, StoryboardRegistry, DEFAULT_WORKFLOW } from '../../packages/session/src/storyboard-orchestrator.ts';
import { DirectorCreativeStore, DIRECTOR_CREATIVE_DB_FILE } from './director-creative-store.ts';
import { DirectorCreativeService } from './director-creative-service.ts';
import type { StoryboardResult } from '../../packages/session/src/storyboard-orchestrator.ts';
import { VideoPromptGenerator } from '../../packages/session/src/video-prompt-generator.ts';
import type { VideoPromptResult } from '../../packages/session/src/video-prompt-generator.ts';
import { renderDirectorMarkdown, safeParseStage, PanelsSchemaLenient } from '../../packages/prompt/src/storyboard.ts';
import type { Panel } from '../../packages/prompt/src/storyboard.ts';
import {
  OpenAICompatibleClient,
  type ChatCompletionClient,
  type ChatRequest,
} from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady, readLocalEnvCredential, credentialLockdownActive } from '../../packages/proxy/src/config.ts';
import {
  ProviderRegistry,
  ProviderRegistryError,
} from '../../packages/proxy/src/provider-registry.ts';
import { createRegistryProviderClient } from '../../packages/proxy/src/provider-client.ts';
import {
  AgentProviderConfigFileError,
  loadAgentProviderConfig,
  normalizeAgentProviderConfig,
  resolveAgentProviderSelection,
  writeAgentProviderConfig,
  type AgentProviderConfig,
} from './agent-provider-config.ts';
import { OperationalReplayBridge } from './operational-replay-bridge.ts';
import {
  CachedLegacyAgentSkillCatalogResolver,
  createFilesystemLegacyAgentSkillCatalogAdapter,
  createSessionAgentSkillShadowObserver,
  evaluateSessionAgentSkillShadowPromotion,
  SessionAgentSkillShadowHealthWindow,
  SessionAgentSkillShadowRunner,
  SessionAgentSkillShadowMetrics,
} from './skill-hub/index.ts';
import { createStylePackageShadowObserver, STYLE_PACKAGE_SHADOW_PIN } from './skill-hub/style-package-shadow.ts';
import { createStylePackageCanary, STYLE_PACKAGE_CANARY_FILE } from './skill-hub/style-package-canary.ts';
import { SkillPackagePinStore } from './skill-package-pin-store.ts';
import { readSkillPinApi, setSkillPinApi } from './skill-governance-api.ts';
import { readSkillActiveDiffApi } from './skill-promotion-api.ts';
import { readCurrentTurnAgentEvidence } from './turn-agent-evidence.ts';
import {
  parseAgentSkillShadowRuntimeConfig,
  publicAgentSkillShadowRuntimeSummary,
} from './agent-skill-shadow-runtime-config.ts';
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
import {
  decideRouteAccess,
  matchRouteAccess,
  sessionScopedRouteTarget,
} from './route-access.ts';
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
  PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
  PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
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
  type PublicMaintenanceProposalReviewItem,
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
import {
  rawEntriesOf, stableEntryUid, toTavernHelperEntry, applyChangedEntries, type TavernHelperEntry,
} from './worldbook-bridge.ts';
import { loadOrCreateInstallationIdentity } from './installation-identity.ts';
import { TurnJobConflictError } from './turn-job-manager.ts';
import { TurnJobAdmissionError, TurnJobService } from './turn-job-service.ts';
import {
  InvalidationHub,
  publishAgentLoopTaskInvalidation,
  publishMaintenanceLifecycleInvalidation,
} from './event-hub.ts';
import { createAgentLoopTaskInvalidationDrainer } from './agent-loop-task-invalidation.ts';
import { readAgentLoopTaskStatus, readAgentLoopTaskExplanation } from './agent-loop-task-status.ts';
import { readAgentLoopTaskOutcomeStatus } from './agent-loop-task-outcome.ts';
import { AgentLoopSummaryApplyOutcomeReader } from './agent-loop-summary-apply-task-outcome.ts';
import { AgentLearningLedger } from './agent-learning-ledger.ts';
import { LearningOutboxDrainer } from './learning-outbox-drainer.ts';
import { normalizeStyleCompileBinding } from '../../packages/memory/public/style-compile-intent-outbox.ts';
import { createStyleCompilePipeline } from './skill-hub/style-compile-pipeline.ts';
import { StyleCompileJobStore, STYLE_COMPILE_JOB_DB_FILE, STYLE_COMPILE_JOB_DATA_DIRECTORY } from './skill-hub/style-compile-job-store.ts';
import { startStyleCompileRuntime, type StyleCompileRuntime } from './skill-hub/style-compile-runtime.ts';
import { parseStyleCompileRuntimeConfig } from './skill-hub/style-compile-runtime-config.ts';
import { createStyleCompilePilotClient } from './skill-hub/style-compile-pilot.ts';
import { scanStyleCompileRecoverySessions } from './skill-hub/style-compile-session-inventory.ts';
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
import {
  SessionDeletionCoordinator,
  type SessionDeletionReservation,
} from './session-deletion-coordinator.ts';
import { createDshSessionDeletionStep } from './dsh-session-deletion-adapter.ts';
import { cleanupDeletedSessionSnapshotArtifacts } from './session-deletion-snapshot-cleanup.ts';
import { createP14EvidenceSessionDeletionStep } from './p14-evidence-deletion-adapter.ts';
import {
  MaintenanceJobManager,
  MaintenanceDisabledError,
  createMaintenanceProductionQueuedJobReaderInternal,
  type MaintenanceProductionProjectionRecoveryCursor,
} from './maintenance-job-manager.ts';
import {
  MaintenanceHarnessService,
  maintenanceSystemPrompt,
  type MaintenanceHarnessServiceOptions,
  type MaintenanceRuntimeObservation,
} from './maintenance-harness-service.ts';
import {
  createMaintenanceDrainPump,
  type MaintenanceDrainPump,
} from './maintenance-drain-pump.ts';
import { MaintenanceProposalControl } from './maintenance-proposal-control.ts';
import { createNpcMaintenanceProposalAdapters } from './npc-maintenance-proposal-adapter.ts';
import { npcOccupiedRelationshipTargets } from './npc-relationship-occupancy.ts';
import { NpcMaintenanceApplyBackupStore } from './npc-maintenance-apply-backup.ts';
import { MemorySummaryMaintenanceCommitter } from './memory-summary-maintenance-committer.ts';
import { shadowDiff } from './maintenance-proposal-committer.ts';
import {
  boundedNpcReviewText,
  npcReviewProposalHasCompleteWriteReview,
  shouldExposeDynamicNpcReviewItems,
} from './npc-maintenance-review-surface.ts';
import {
  maintenanceReviewHasApplicableWrite,
  typedMaintenanceProposalReviewItems,
} from './maintenance-proposal-review-surface.ts';
import {
  assertMaintenanceMemorySummaryCommitAllowed,
  maintenanceGuardedAutoAllowsNpcSession,
  maintenanceMemorySummaryApplyMode,
  maintenanceProposalApplySupported,
  parseMaintenanceApplyRuntimeConfig,
} from './maintenance-apply-runtime-config.ts';
import {
  deleteNpcMaintenanceActivationSession,
  readNpcMaintenanceActivationMarkers,
} from './npc-maintenance-activation.ts';
import {
  NPC_APPLY_POLICY_LIMITS,
  evaluateNpcApplyPolicy,
  type NpcApplyOccupiedFactTarget,
} from '../../packages/agent-policy/src/npc-apply-policy.ts';
import {
  normalizeNpcMaintenanceProposal,
  type NpcMaintenanceProposalContext,
} from '../../packages/agent-policy/src/npc-maintenance-proposal.ts';
import { createAdmittedMaintenanceModel } from './admitted-maintenance-model.ts';
import { AgentLoopProjectionStore } from './agent-loop-projection-store.ts';
import { startAgentLoopRecoveryLifecycle } from './agent-loop-recovery-lifecycle.ts';
import { arbitratedAgentClient, resolvedArbitratedAgentClient } from './agent-arbitrated-client.ts';
import { shadowJobSourceState } from './agent-loop-turnjob-shadow.ts';
import {
  AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION,
  bindAgentLoopMaintenanceProductionCanaryExecutionPort,
  createAgentLoopServerComposition,
  isAgentLoopServerCompositionCapabilityManifest,
  readAgentLoopServerCompositionCapabilityManifest,
} from './agent-loop-runtime.ts';
import {
  createAgentLoopMaintenanceCanaryAdmissionReaderInternal,
  createAgentLoopMaintenanceCanarySourcePolicyReader,
}
  from './agent-loop-maintenance-canary-source-policy.ts';
import { AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2 }
  from './agent-loop-maintenance-canary-route-plan-v2.ts';
import {
  createAgentLoopMaintenanceProductionDispatcher,
  createAgentLoopMaintenanceProductionRouteSnapshotReaderInternal,
} from './agent-loop-maintenance-production-dispatcher.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT,
}
  from './agent-loop-maintenance-production-route-contract.ts';
import type { AgentLoopMaintenancePrepareSource } from './agent-loop-prepare.ts';
import { createAgentLoopMaintenanceExecutionPrepare, assertAgentLoopMaintenancePreparedBinding } from './agent-loop-maintenance-execution-prepare.ts';
import { issueAgentLoopGetVariablesAuthorization, agentLoopMaintenanceBindingRef } from './agent-loop-get-variables-authorization.ts';
import { createAgentLoopMaintenanceCorrectionPrepare } from './agent-loop-maintenance-correction-prepare.ts';
import { createAgentLoopMaintenanceCorrectionModel } from './agent-loop-maintenance-correction-model.ts';
import { createAgentLoopMaintenanceCorrectionProposalPrepare } from './agent-loop-maintenance-correction-proposal-prepare.ts';
import { createAgentLoopMaintenanceCorrectionProposalModel } from './agent-loop-maintenance-correction-proposal-model.ts';
import { createAgentLoopMaintenanceCorrectionProposalAction,
  type AgentLoopMaintenanceCorrectionProposalActionOptions } from './agent-loop-maintenance-correction-proposal-action.ts';
import { revokeAgentLoopCorrectionProposalCapability } from './agent-loop-correction-proposal-authorization.ts';
import { normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import { createAgentLoopMaintenanceGetVariablesAction } from './agent-loop-maintenance-get-variables-action.ts';
import { issueAgentLoopRollingSummaryProposalAuthorization } from './agent-loop-rolling-summary-proposal-authorization.ts';
import { createAgentLoopMaintenanceRollingSummaryProposalAction } from './agent-loop-maintenance-rolling-summary-proposal-action.ts';
import { createAgentLoopMaintenanceRollingSummaryApplyAction } from './agent-loop-maintenance-rolling-summary-apply-action.ts';
import { issueAgentLoopRollingSummaryApplyAuthorization, revokeAgentLoopRollingSummaryApplyCapability,
  assertAgentLoopRollingSummaryApplyModelCapability,
  type AgentLoopRollingSummaryApplyCapability } from './agent-loop-rolling-summary-apply-authorization.ts';
import { createAgentLoopRollingSummaryProposalVerification } from './agent-loop-rolling-summary-proposal-verification.ts';
import { createAgentLoopShadowPublication, createAgentLoopCorrectionShadowPublication } from './agent-loop-shadow-publication.ts';
import type { AgentLoopCorrectionRollingSummaryArtifactSourceOptions } from './agent-loop-rolling-summary-artifacts.ts';
import { createAgentLoopSummaryApplyCompletion } from './agent-loop-summary-apply-completion.ts';
import { sameMaintenanceAgentLoopClaim, type MaintenanceAgentLoopExecutionContext } from './agent-loop-maintenance-lifecycle.ts';
import { consumeAgentLoopModelInvocationPermit, type AgentLoopModelAdmissionScope } from './agent-loop-model-invocation-permit.ts';
import { deriveAgentLoopModelCallBudget } from './agent-loop-model-call-budget.ts';
import type { AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { createMaintenanceModelHostGuard, type MaintenanceModelHostEnvironment } from './maintenance-model-host-guard.ts';
import { assertAgentLoopMaintenanceModelRecord, createAgentLoopMaintenanceModel } from './agent-loop-maintenance-model.ts';
import {
  maintenanceBudgetProfileForAutonomy,
  maintenanceCostEstimator,
  parseMaintenanceRuntimeConfig,
} from './maintenance-runtime-config.ts';
import {
  bindArcMaintenanceReviewSnapshot,
  buildMaintenanceSessionSnapshot,
} from './maintenance-session-snapshot.ts';
import {
  MAINTENANCE_POLICY,
  MAINTENANCE_POLICY_VERSION,
  isMaintenanceTaskKind,
  isWorldbookRepairProposalContext,
  type WorldbookRepairFileEvidence,
  type WorldbookRepairProposalContext,
} from './maintenance-types.ts';
import {
  INTERACTIVE_LEDGER_DB_FILE,
  InteractiveCallLedger,
} from './interactive-call-ledger.ts';
import {
  foregroundSummaryBudgetProfile,
  interactiveBudgetProfileForAutonomy,
  parseInteractiveRuntimeConfig,
} from './interactive-runtime-config.ts';
import { modelRuntimeProfileDigest, resolveModelRuntimeProfile } from '../../packages/prompt/src/model-runtime-profile.ts';
import {
  contextCompilerAllowsSession,
  contextCompilerAllowsShadowSession,
  CONTEXT_COMPILER_SHADOW_POLICY_VERSION,
  parseContextCompilerRuntimeConfig,
} from './context-compiler-runtime-config.ts';
import { agentTaskBudgetProfile } from './agent-task-budget-profiles.ts';
import { ModelUsageLedger } from './model-usage-ledger.ts';
import { AgentAdmissionLedger, AGENT_ADMISSION_DB_FILE } from './agent-admission-ledger.ts';
import { readSessionAgentControl } from './agent-control-api.ts';
import {
  agentCapabilityTicketAllowed,
} from './agent-capability-binding.ts';
import { recordMaintenanceProtocolCircuit } from './maintenance-protocol-circuit.ts';
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
  worldbookEntryDigest,
  type WorldbookAssetAdapter,
} from './worldbook-repair-control.ts';
import { WorldbookRepairControlPlane } from './worldbook-repair-control-plane.ts';
import {
  parseWorldbookRepairRuntimeConfig,
  worldbookRepairForwardAllowsSession,
} from './worldbook-repair-runtime-config.ts';
import {
  agentAdmissionAllowsSession,
  parseAgentAdmissionRuntimeConfig,
} from './agent-admission-runtime-config.ts';
import { parseLearningTextRuntimeConfig } from './learning-text-runtime-config.ts';
import { AdmissionTicketBroker, type AgentAdmissionLease } from './agent-admission-broker.ts';
import {
  AdmittedModelGatewayError,
  AdmittedModelGateway,
  safeAdmittedModelGatewayErrorCode,
  type AdmittedModelGatewayErrorCode,
  type AdmittedModelLeaseAudit,
} from './admitted-model-gateway.ts';
import {
  admissionRequestDigest,
  admissionLimitsFromBudgetProfile,
  agentToolSetDigest,
  parseNsfwAgentState,
} from '../../packages/agent-policy/src/admission.ts';
import {
  agentBudgetProfileDigest,
  normalizeAgentBudgetProfile,
  assertAgentBudgetWithinHostCeiling,
} from '../../packages/agent-policy/src/budget-profile.ts';
import { parseAqlReplanOutput } from '../../packages/agent-policy/public/aql-replan-output.ts';
import { buildAqlReplanRequest, aqlReplanNativeTools } from '../../packages/agent-policy/public/aql-replan-request.ts';
import { captureAqlReplanSkillSource, isAqlReplanSkillSourceCurrent } from './skill-hub/aql-replan-context.ts';
import { aqlReplanSkillLiveEnabled, aqlReplanSkillPolicyAllowed, createAqlReplanSkillLiveCall }
  from './skill-hub/aql-replan-live.ts';
import { createAqlReplanSkillHostAuthority } from './skill-hub/aql-replan-host-authority.ts';
import { commitAqlReplanSkillSourceReceipt } from './aql-replan-skill-source.ts';
import { parseAqlReplanInput, renderAqlReplanInput } from '../../packages/agent-policy/public/aql-replan-input.ts';
import {
  captureAqlSummaryRequestEvidence, isAqlSummaryRequestEvidenceCurrent, commitAqlSummaryRequestEvidence,
} from './aql-summary-request-evidence.ts';
import {
  parseLearnedStyleModelResponse,
  STYLE_DRAFT_TOOL_NAME,
} from '../../packages/agent-policy/src/style-compiler.ts';
import { evaluateLearnedStyleDraft } from '../../packages/agent-policy/src/style-evaluator.ts';
import {
  buildForegroundSummaryModelRequest, foregroundSummaryNativeTools,
} from '../../packages/harness/public/foreground-summary-model.ts';
import {
  selectArcSessionProjection,
  selectNpcSessionProjection,
} from '../../packages/agent-policy/src/domain-projection-contract.ts';
import { effectiveInteractiveNativeTools } from '../../packages/harness/src/interactive-tools.ts';
import {
  CONTEXT_COMPILER_POLICY_VERSION,
  ContextCapsuleCache,
  buildContextCompilerModelRequest,
  parseContextCapsule,
  partitionContextCompilerSources,
} from '../../packages/harness/src/context-compiler.ts';
import { buildPrecommitCriticRequestFromInput } from '../../packages/harness/precommit-critic-model.ts';
import { createCriticInput, criticInputManifest } from '../../packages/harness/public/critic-input.ts';
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
import { AgentClosureStore } from './agent-closure-store.ts';
import { AgentClosureRecorder } from './agent-closure-recorder.ts';
import { executionClassForLearningSession } from '../../packages/agent-closure/index.ts';
import {
  agentLaneRolloutBucketIdentity,
  parseAgentLaneRuntimeConfig,
} from './agent-lane-runtime-config.ts';
import {
  AGENT_ROLLOUT_LANES,
  evaluateAgentLaneRollout,
  type AgentRolloutLane,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import {
  ObservedChatCompletionClient,
  configuredModelUsageCostEstimator,
} from './model-usage-client.ts';
import { releaseDrainState } from './release-drain.ts';
import {
  NsfwSceneSafetyControl,
  NsfwSceneSafetyControlError,
  parseNsfwSceneSafetyUpdate,
} from './nsfw-scene-safety-control.ts';
import { NsfwSceneAttestationMemory } from './nsfw-scene-attestation-memory.ts';

function parsePort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('JG_WEB_PORT 必须是 1..65535 的整数');
  }
  return port;
}

const PORT = parsePort(process.env.JG_WEB_PORT, 17800);
const HOST = '127.0.0.1';
const APP_VERSION = '0.6.1';
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
const CONTEXT_COMPILER_CANARY = CONTEXT_COMPILER_RUNTIME.canaryScope
  ? new ContextCompilerCanarySamples(CONTEXT_COMPILER_RUNTIME.canaryScope) : null;
const CONTEXT_COMPILER_SHADOW_RUNNER = new ContextCompilerShadowRunner();
const LEARNING_TEXT_RUNTIME = parseLearningTextRuntimeConfig();
const STYLE_COMPILE_RUNTIME_CONFIG = parseStyleCompileRuntimeConfig(process.env);
let STYLE_COMPILE_RUNTIME: StyleCompileRuntime | null = null;
let styleCompileStartupReady = false;
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
  import('../../packages/session/src/session.ts').SessionArgs['learnedStyleResolver']
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
// Activation evidence belongs to the post-recovery data generation and is inspected only
// after this process owns the dataDir. This closes the gap in which activation or restore
// could replace the marker/backups while startup was validating them.
let NPC_MAINTENANCE_ACTIVATIONS: ReturnType<typeof readNpcMaintenanceActivationMarkers> = Object.freeze([]);
try {
  NPC_MAINTENANCE_ACTIVATIONS = readNpcMaintenanceActivationMarkers(DATA_DIR);
} catch {
  // Backup evidence is an apply-only credential. Invalid evidence keeps formal
  // writes closed, but must not suppress shadow proposal generation.
  console.warn('[NPCMaintenance] ACTIVATION_INVALID（NPC 正式写入已关闭，shadow 提案继续）');
}
const NPC_MAINTENANCE_ACTIVATION_SESSIONS = new Set(
  NPC_MAINTENANCE_ACTIVATIONS.map((record) => record.sessionId),
);
const MAINTENANCE_APPLY_RUNTIME = parseMaintenanceApplyRuntimeConfig(process.env, {
  npcActivationSessions: NPC_MAINTENANCE_ACTIVATION_SESSIONS,
});
// H7: authoritative deletion fences live beside DATA_DIR so a snapshot restore cannot roll them back.
// Opening this store is fail-closed: a corrupt privacy journal must prevent the server from serving
// restored session bytes without their tombstones.
const SESSION_DELETION_JOURNAL = new SessionDeletionJournal({ dataDir: DATA_DIR });
const SESSION_DELETION_RESERVATIONS = new Map<string, SessionDeletionReservation>();
const sessionDeletionAdmissionOpen = (sessionId: string): boolean => (
  !SESSION_DELETION_RESERVATIONS.has(sessionId)
  && !SESSION_DELETION_JOURNAL.isBlocked(sessionId)
);
// A disabled forward runtime must still reopen prior audit evidence so session
// deletion can erase it. Runtime disablement is not a privacy-retention switch.
const INTERACTIVE_CALL_LEDGER = INTERACTIVE_RUNTIME.enabled
  || existsSync(resolve(DATA_DIR, INTERACTIVE_LEDGER_DB_FILE))
  ? new InteractiveCallLedger({ dataDir: DATA_DIR })
  : null;
const MODEL_USAGE_LEDGER = new ModelUsageLedger({ dataDir: DATA_DIR });
const AGENT_CONTROL_STORE = new AgentControlStore({ dataDir: DATA_DIR });
for (const laneId of AGENT_ROLLOUT_LANES) {
  try {
    const repaired = AGENT_CONTROL_STORE.repairLegacyLatencySampleDenominatorKill(laneId);
    if (repaired) {
      console.warn(
        `[AgentControl] repaired ${laneId} ${repaired.operation}; reopened window `
        + `${repaired.authorizationWindow.sequence} in test-session`,
      );
    }
  } catch (error) {
    // A failed compatibility repair must not mutate or bypass the persisted stop.
    console.error(
      `[AgentControl] latency denominator repair failed for ${laneId}: ${(error as Error).message}`,
    );
  }
}
let AGENT_CLOSURE_DEGRADED = false;
const AGENT_CLOSURE_STORE = (() => {
  try { return new AgentClosureStore({ dataDir: DATA_DIR }); }
  catch (error) {
    AGENT_CLOSURE_DEGRADED = true;
    console.error(`[AgentClosure] initialization failed; evaluation disabled: ${(error as Error).message}`);
    return null;
  }
})();
const AGENT_CLOSURE_RECORDER = AGENT_CLOSURE_STORE
  ? new AgentClosureRecorder(
    AGENT_CLOSURE_STORE,
    () => new Date().toISOString(),
    (code) => {
      AGENT_CLOSURE_DEGRADED = true;
      console.warn(`[AgentClosure] ${code}`);
    },
  )
  : null;
const NSFW_SCENE_SAFETY_CONTROL = new NsfwSceneSafetyControl();
// Device-wide memory of the latest adult attestation, used only to pre-fill a new session's
// grant form. A failed write here must never break the per-session gate itself.
const NSFW_SCENE_ATTESTATION_MEMORY = new NsfwSceneAttestationMemory(DATA_DIR);
const WORLDBOOK_REPAIR_ASSET: WorldbookAssetAdapter = Object.freeze({
  read: (file: string) => readRevisionedAsset('worldbook', file),
  readLayer: (file: string, source: 'asset') => readRevisionedAssetLayer('worldbook', file, source),
  save: (file: string, raw: string, expectedRevision: string) => AGENT_CONTROL_STORE.withAssetMutation(
    () => saveUserAssetCas('worldbook', file, raw, expectedRevision),
  ),
  deleteUserOverride: (file: string, expectedRevision: string, expectedAssetRevision: string) => (
    AGENT_CONTROL_STORE.withAssetMutation(
      () => deleteUserAssetOverrideCas('worldbook', file, expectedRevision, expectedAssetRevision),
    )
  ),
});
// Existing control state is reopened even after the forward gate is disabled so
// trusted operators retain reject/revert recovery access.
const WORLDBOOK_REPAIR_CONTROL = WORLDBOOK_REPAIR_RUNTIME.enabled
  || existsSync(resolve(DATA_DIR, WORLDBOOK_REPAIR_DB_FILE))
  ? new WorldbookRepairControl({
    dataDir: DATA_DIR,
    asset: WORLDBOOK_REPAIR_ASSET,
    // P16 C2.2：世界书修正的 create/apply/revert 回执直连旁路评估层。
    // best-effort —— 评估失败不得影响控制面结果（控制面内部已 try/catch）。
    observe: observeWorldbookApplyTransition,
  })
  : null;
const AGENT_ADMISSION_LEDGER = AGENT_ADMISSION_RUNTIME.enabled
  || skillCompileEnabled()
  || skillEvaluateEnabled()
  || skillSampleEnabled()
  || skillQualityEnabled()
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
// Retained metadata recovers even after forward recording is disabled; it never enables an Agent.
let AGENT_EVIDENCE_LEDGER = openAgentEvidenceRuntime({
    dataDir: DATA_DIR, recordingEnabled: process.env.JG_EXPLICIT_PREFERENCE_ADOPTION_EVIDENCE === '1'
        || process.env.JG_AGENT_SKILL_EVIDENCE === '1',
    resolveSession: (file) => resolveSessionDatabase(DATA_DIR, file),
    isSessionDeleted: (rawSessionId) => SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
    onFailure: (code) => console.warn(`[AgentEvidence] ${code}（原回执保留，前台继续）`),
});
const MODEL_USAGE_COST = configuredModelUsageCostEstimator();
const CONTEXT_COMPILER_SHADOW_RATES = Object.freeze({ input: process.env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK,
  output: process.env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK });
const AGENT_SKILL_CANDIDATE_RUNTIME = openAgentSkillCandidateRuntime({
    dataDir: DATA_DIR, submissionEnabled: candidateSubmissionsEnabled,
    onFailure: (code) => console.warn(`[AgentSkillCandidate] ${code}（候选保留，原Agent继续）`),
});
const SKILL_OPERATIONAL_SOURCE = AGENT_SKILL_CANDIDATE_RUNTIME && AGENT_CLOSURE_STORE
  ? createSkillOperationalSource({
    candidates: AGENT_SKILL_CANDIDATE_RUNTIME,
    closures: AGENT_CLOSURE_STORE,
    sourceAllowed: (rawSessionId) => !SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
  })
  : null;
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
      agentLaneRolloutBucketIdentity(runtime, sessionId),
      runtime.ceilings.maintenance,
    ).allowed;
  } catch {
    return false;
  }
};
const maintenanceTaskExecutionAllowed = (
  sessionId: string,
  taskKind?: import('./maintenance-types.ts').MaintenanceTaskKind,
): boolean => {
  if (!sessionDeletionAdmissionOpen(sessionId)) return false;
  if (!maintenanceLaneExecutionAllowed(sessionId)) return false;
  // NPC activation/backup is deliberately absent here: shadow proposal
  // execution is governed by the Maintenance lane and capability only. The
  // per-session backup proof is acquired at the final guarded apply boundary.
  if (!taskKind) return true;
  try {
    return agentCapabilityTicketAllowed(AGENT_CONTROL_STORE, {
      taskKind,
      policyVersion: MAINTENANCE_POLICY_VERSION,
    });
  } catch {
    return false;
  }
};
const agentTicketControl = (
  input: Pick<import('../../packages/agent-policy/src/admission.ts').AdmissionRequest,
    'sessionId' | 'lane' | 'taskKind' | 'policyVersion'>,
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
    lane,
    agentLaneRolloutBucketIdentity(runtime, input.sessionId),
    runtime.ceilings[lane],
  ).allowed) {
    return false;
  }
  return AGENT_CONTROL_STORE.get(lane);
};
/**
 * P16 C2.3 / C3：`learning.*` 与 `interactive.*` 都没有维护 job，证据来源只能按**会话种类**判定。
 *
 * 生产证据 = 本机 managed-local 真实会话，且学习 lane 当前**不处于 `test-session` 灰度**。
 * `test-session` 下的产出是本机真跑、但不是生产证据，记 `operational-replay`：既不进生产
 * 分母，也不像 `fixture` 那样从报表里彻底消失。运营 replay / 离线脚本不走本路径，必须
 * 显式声明 `replay`；判定失败一律 `unknown`（由合同 fail-closed 记 `fixture`）。
 *
 * 这里用**纯函数** `evaluateAgentLaneRollout` 而不是 `AGENT_CONTROL_STORE.decide()`：
 * 后者在 `shouldKill` 时会**写入** kill，观测路径绝不能产生业务副作用。
 */
const agentSessionKind = (sessionId: string): 'production' | 'replay' | 'unknown' => {
  try {
    const runtime = parseAgentLaneRuntimeConfig(process.env);
    const managed = runtime.managed;
    const decision = evaluateAgentLaneRollout({
      lane: 'learning',
      sessionId: managed ? agentLaneRolloutBucketIdentity(runtime, sessionId) : sessionId,
      desiredState: managed ? AGENT_CONTROL_STORE.get('learning').desiredState : 'on',
      hostCeiling: managed ? runtime.ceilings.learning : 'on',
      evidence: AGENT_CONTROL_STORE.evidence('learning'),
    });
    return decision.effectiveState === 'test-session' ? 'replay' : 'production';
  } catch {
    return 'unknown';
  }
};
/**
 * P16 C2.3：操作者对 Style 提案 approve / rollback / disable 之后的转换证据。
 *
 * 读回发生在**提交之后**：从磁盘重读 `proposal.json`（权威真值）并核对派生 Skill 的
 * 绑定。读回不成立就只记 `apply-committed`，绝不合成 `verified`。停用没有生效版本，
 * 因此不产生读回，只把**原链**标成 `rolled-back`。
 */
const observeStyleCompileControl = (
  proposal: StyleProposal,
  status: 'applied' | 'reverted' | 'disabled',
): void => {
  if (!AGENT_CLOSURE_RECORDER) return;
  const lineage = proposal.versions[0];
  if (!lineage) return;
  let readbackDigest: string | undefined;
  if (status !== 'disabled') {
    try {
      readbackDigest = LEARNED_STYLE_PROPOSALS.readback(proposal.id).readbackDigest;
    } catch {
      // fail-closed：回读未成立 ⇒ 证据停在 apply，由 C4 的 reconciler 补录。
      readbackDigest = undefined;
    }
  }
  AGENT_CLOSURE_RECORDER.observeStyleCompileTransition({
    proposalId: proposal.id,
    lineageDigest: lineage.sourceDigest,
    occurredAt: new Date().toISOString(),
    status,
    ...(readbackDigest ? { readbackDigest, targetRevision: readbackDigest } : {}),
  });
};
const agentTicketAllowed = (
  input: import('../../packages/agent-policy/src/admission.ts').AdmissionRequest,
): boolean | Readonly<{
  allowed: true;
  maxModelCalls: number;
  quotaReservationDigest: string;
  quotaWindowSequence: number;
  reservationCreated: boolean;
  allowedLeaseClaimPurposes?: readonly ['server-agent-skill-profile-admission-v1'];
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
      quotaWindowSequence: reservation.windowSequence,
      reservationCreated: reservation.created,
      ...(AGENT_CLOSURE_STORE && (
        (agentSkillLiveEnabled(process.env) && input.taskKind === 'context_compiler'
          && (input.policyVersion === CONTEXT_COMPILER_POLICY_VERSION || input.policyVersion === 'p14-q9r-context-compiler-v2'))
        || (criticSkillLiveEnabled(process.env) && input.taskKind === 'critic_revision'
          && input.policyVersion === CRITIC_SKILL_POLICY_VERSION)
        || (preludeSkillLiveEnabled(process.env) && input.taskKind === 'interactive_prelude'
          && preludeSkillPolicyAllowed(input.policyVersion))
        || (variableProposalSkillLiveEnabled(process.env) && input.taskKind === 'interactive_prelude'
          && variableProposalSkillPolicyAllowed(input.policyVersion))
        || (aqlReplanSkillLiveEnabled(process.env) && input.taskKind === 'aql_replan'
          && aqlReplanSkillPolicyAllowed(input.policyVersion))
        || (maintenanceMemorySkillLiveEnabled(process.env) && input.taskKind === 'memory_consolidation'
          && maintenanceMemorySkillPolicyAllowed(input.policyVersion))
        || (maintenanceSummarySkillLiveEnabled(process.env) && input.taskKind === 'rolling_summary'
          && maintenanceSummarySkillPolicyAllowed(input.policyVersion))
        || (maintenanceArcSkillLiveEnabled(process.env) && input.taskKind === 'branch_index'
          && maintenanceArcSkillPolicyAllowed(input.policyVersion))
        || (maintenanceNpcSkillLiveEnabled(process.env) && input.taskKind === 'npc_state'
          && maintenanceNpcSkillPolicyAllowed(input.policyVersion))
        || (maintenanceWorldbookSkillLiveEnabled(process.env) && input.taskKind === 'worldbook_repair'
          && maintenanceWorldbookSkillPolicyAllowed(input.policyVersion))
        || (learningPreferenceSkillLiveEnabled(process.env) && input.taskKind === 'preference_extract'
          && learningPreferenceSkillPolicyAllowed(input.policyVersion))
        || (branchPreferenceSkillLiveEnabled(process.env) && input.taskKind === 'preference_extract'
          && branchPreferenceSkillPolicyAllowed(input.policyVersion))
        || (styleCompileSkillLiveEnabled(process.env) && input.taskKind === 'style_compile'
          && styleCompileSkillPolicyAllowed(input.policyVersion)))
        ? { allowedLeaseClaimPurposes: ['server-agent-skill-profile-admission-v1'] as const } : {}),
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
    sessionId: agentLaneRolloutBucketIdentity(runtime, ticket.sessionId),
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
  AGENT_CONTROL_STORE.decide(
    input.lane,
    agentLaneRolloutBucketIdentity(runtime, input.sessionId),
    ceiling,
  );
};
const recordMaintenanceProtocolObservation = (input: MaintenanceRuntimeObservation): void => {
  recordMaintenanceProtocolCircuit(AGENT_CONTROL_STORE, input);
};
const recordAgentRuntimeLease = (entry: AdmittedModelLeaseAudit, qualifyingSample = true): void => {
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
    qualifyingSample: qualifyingSample && entry.outcome === 'completed' && entry.authorizationCallsUsed > 0,
    providerCalls: entry.authorizationCallsUsed,
    providerErrors: entry.providerErrorAttemptsUsed,
    ...(entry.authorizationCallsUsed > 0 ? { latencyMs: entry.wallMsUsed } : {}),
  });
};
let modelUsageRecordWarningEmitted = false;
process.once('exit', () => {
  STYLE_COMPILE_RUNTIME?.stop();
  try { MODEL_USAGE_LEDGER.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_ADMISSION_LEDGER?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_LEARNING_LEDGER?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_EVIDENCE_LEDGER?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_SKILL_CANDIDATE_RUNTIME?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SKILL_QUALITY_RUNTIME?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SKILL_SAMPLE_RUNTIME?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { CANDIDATE_EVALUATION_SAMPLE_HOST.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SKILL_EVALUATION_BATCH_STORE?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SKILL_PROMOTION_RUNTIME?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SKILL_EVALUATE_RUNTIME?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { SKILL_COMPILE_RUNTIME?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { ARC_PROJECTIONS?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { WORLDBOOK_REPAIR_CONTROL?.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_CONTROL_STORE.close(); } catch { /* graceful shutdown normally closes first */ }
  try { AGENT_CLOSURE_STORE?.close(); } catch { /* graceful shutdown normally closes first */ }
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
AGENT_CONTROL_STORE.recoverAssetMutationPending(() => ASSET_IMPORT_TRANSACTIONS.recover());
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
/** 前端日志落盘路径（日志模块 v0.6.1：浏览器批量上报 → 逐行追加） */
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
const EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
    ? createExplicitPreferenceEvidenceScheduler({
        ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
        open: (rawSessionId) => {
            if (!sessionDeletionAdmissionOpen(rawSessionId)) return null;
            const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
            return path ? openExplicitPreferenceEvidenceSource(path, rawSessionId) : null;
        },
        onFailure: () => console.warn('[AgentEvidence] RECEIPT_DELIVERY_PENDING（原回执保留，等待下次触发）'),
    }) : null;
const CLOSURE_SKILL_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER && AGENT_CLOSURE_STORE
    ? createClosureSkillEvidenceScheduler({
        ledger: AGENT_EVIDENCE_LEDGER, closure: AGENT_CLOSURE_STORE, allowed: sessionDeletionAdmissionOpen,
        onClosureReady: (id) => { scheduleReportedEffectEvidence(id); wakeEffectWatchRecovery(id); },
        open: (rawSessionId) => {
            if (!sessionDeletionAdmissionOpen(rawSessionId)) return null;
            const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
            return path ? openClosureSkillEvidenceSource(path, rawSessionId) : null;
        },
        onFailure: () => console.warn('[AgentEvidence] SKILL_RECEIPT_DELIVERY_PENDING（原回执保留，等待下次触发）'),
    }) : null;
const LEARNING_PREFERENCE_SOURCE_SCHEDULER = AGENT_LEARNING_LEDGER ? createLearningPreferenceSkillSourceScheduler({
  ledger: AGENT_LEARNING_LEDGER, allowed: sessionDeletionAdmissionOpen,
  open: (sessionId) => {
    if (!sessionDeletionAdmissionOpen(sessionId)) return null;
    const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
    return path ? openLearningPreferenceSkillSourceRecovery(path, sessionId) : null;
  },
  onFailure: () => console.warn('[AgentLearning] PREFERENCE_SOURCE_RECOVERY_PENDING（原来源保留，后台退避重试）'),
}) : null;
let skillDrainWarningEmitted = false;
const SKILL_CONSUMPTION_SCHEDULER = AGENT_CLOSURE_STORE ? createAgentSkillConsumptionScheduler({
  closure: AGENT_CLOSURE_STORE,
  allowed: sessionDeletionAdmissionOpen,
  onDelivered: (id) => { scheduleReportedEffectEvidence(id); wakeEffectWatchRecovery(id); },
  open: (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      const outbox = session.readAgentSkillConsumptionOutbox();
      return outbox ? { outbox, close() {} } : null;
    }
    const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
    if (!path || !existsSync(path)) return null;
    // Restart recovery opens only the metadata outbox, not ChatSession, assets or a Provider.
    const db = new DatabaseSync(path);
    try {
      const outbox = AgentSkillConsumptionOutbox.openExisting(db);
      if (!outbox) { db.close(); return null; }
      return { outbox, close: () => db.close() };
    } catch (error) { db.close(); throw error; }
  },
  onFailure: () => {
    if (!skillDrainWarningEmitted) {
      skillDrainWarningEmitted = true;
      console.warn('[AgentSkill] CONSUMPTION_DRAIN_PENDING（保留待送回执，后台退避重试）');
    }
  },
}) : null;
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

function resolveAgentSelection() {
  const main = loadProviderConfig();
  return resolveAgentProviderSelection({
    // P16 T-1：凭据封锁（测试安全门）下不得读取 agent-provider.json。
    config: loadAgentProviderConfig({ ignoreFile: credentialLockdownActive() }),
    main: { providerId: main.providerId, model: main.model },
    describe: (providerId) => providerRegistry.describe(providerId),
  });
}

/** Resolve and freeze an Agent provider/model at one admission boundary. */
function agentModelBinding(selection = resolveAgentSelection()): {
  selection: ReturnType<typeof resolveAgentSelection>;
  client: ChatCompletionClient;
} {
  const fixedSelection = Object.freeze({ providerId: selection.providerId, model: selection.model });
  const client = createRegistryProviderClient({
    registry: providerRegistry,
    resolveSelection: () => fixedSelection,
  });
  return {
    selection: fixedSelection,
    client: observeServerModelClient(client, () => fixedSelection.providerId),
  };
}

function contextCompilerRuntimeAllows(config: ReturnType<typeof parseContextCompilerRuntimeConfig>, sessionId: string): boolean {
  if (CONTEXT_COMPILER_RUNTIME.mode === 'canary' && config.mode !== 'canary') return false;
  if (config.mode !== 'canary') return contextCompilerAllowsSession(config, sessionId);
  if (CONTEXT_COMPILER_RUNTIME.mode !== 'canary' || !CONTEXT_COMPILER_CANARY
    || CONTEXT_COMPILER_CANARY.scope.sessionId !== sessionId) return false;
  if (process.env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK !== CONTEXT_COMPILER_SHADOW_RATES.input
    || process.env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK !== CONTEXT_COMPILER_SHADOW_RATES.output)
    throw new Error('context-canary-pricing-stale');
  const { selection, client } = agentModelBinding();
  const current = parseContextCompilerRuntimeConfig(process.env, modelRuntimeProfileFor(selection, client));
  if (!current.budgetProfile || JSON.stringify(current.canaryScope) !== JSON.stringify(CONTEXT_COMPILER_CANARY.scope)
    || !contextCompilerAllowsSession(current, sessionId, { providerId: selection.providerId, model: selection.model,
      profileDigest: agentBudgetProfileDigest(current.budgetProfile) })) throw new Error('context-canary-scope-stale');
  return true;
}

const OPERATIONAL_REPLAY_BRIDGE = process.env.JG_OPERATIONAL_REPLAY_BRIDGE === '1'
  ? new OperationalReplayBridge({
      dataDir: DATA_DIR,
      serverInstanceId: SERVER_INSTANCE_ID,
      resolveSelection: resolveAgentSelection,
      complete: (selection, request, context) => {
        const fixedSelection = Object.freeze({ providerId: selection.providerId, model: selection.model });
        const client = createRegistryProviderClient({
          registry: providerRegistry,
          resolveSelection: () => fixedSelection,
          createRequestId: () => context.requestId,
        });
        return arbitratedAgentClient(client, fixedSelection, 'operational-replay').complete(
          request as unknown as ChatRequest, context.signal,
          { runId: context.runId, maxTransportAttempts: context.maxTransportAttempts },
        );
      },
    })
  : null;
process.once('exit', () => { OPERATIONAL_REPLAY_BRIDGE?.disposeSync(); });

// P17-02.1: shadow recovery never grants execution authority. Legacy Managers
// must be initialized/reconciled before even reconstructing their projections.
let agentLoopLegacySourceReady = false;
let agentLoopManagerReadersReady = false;
// Private pre-write binding, keyed by this exact Service/Runtime context. No
// persisted DTO or post-write reconstruction can create this host bundle.
const AGENT_LOOP_APPLY_COMPLETION_HOSTS = new WeakMap<MaintenanceAgentLoopExecutionContext, ReturnType<typeof createAgentLoopSummaryApplyCompletion>>();
const AGENT_LOOP_PROJECTION_STORE = new AgentLoopProjectionStore({
  dataDir: resolve(DATA_DIR, 'agent-loop-projection'),
  now: () => new Date().toISOString(),
});
const AGENT_LOOP_RUNTIME = createAgentLoopServerComposition({
  store: AGENT_LOOP_PROJECTION_STORE,
  ownerId: `server.${SERVER_INSTANCE_ID}`,
  clock: () => new Date().toISOString(),
  readers: {
    readTurnJob: (runId) => agentLoopManagerReadersReady ? turnJobs.get(runId) : null,
    readMaintenanceJob: (runId) => agentLoopManagerReadersReady ? maintenanceJobs.get(runId) : null,
  },
  maintenancePrepareSource: (runId) => readAgentLoopMaintenancePrepareSource(runId),
  // Lazy host ports share this runtime's Coordinator. Construction never reads a TDZ Manager or allocates a Client.
  maintenanceExecution: {
    // Versioned, mutually exclusive production profile. Capturing this factory
    // constructs no context-bound bundle and grants no claim or execution right.
    executionProfile: {
      version: AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION,
      route: 'correction-proposal',
      publication: 'required',
      correctionProposal: (context, step, lifetime) =>
        createAgentLoopMaintenanceHostCorrectionProposal(context, step, lifetime),
    },
    readExecution: (runId) => agentLoopManagerReadersReady ? maintenanceJobs.readExecution(runId) : null,
    prepare: (context, step) => createAgentLoopMaintenanceHostPrepare({
      runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
      expectedRevision: step.revision, signal: context.signal,
    }).prepare(step),
    decide: (context, step) => createAgentLoopMaintenanceHostModel({
      runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
      expectedRevision: step.revision, signal: context.signal,
    }).decide(step),
    getVariables: {
      prepare: (context, step) => createAgentLoopMaintenanceHostPrepare({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.revision, signal: context.signal,
      }).prepareGetVariables(step),
      act: (context, step) => createAgentLoopMaintenanceHostAction({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.actionRequest.expectedTaskRevision, signal: context.signal,
      }).act(step),
    },
    rollingSummaryProposal: {
      prepare: (context, step) => createAgentLoopMaintenanceHostPrepare({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.revision, signal: context.signal,
      }).prepareRollingSummaryProposal(step),
      act: (context, step) => createAgentLoopMaintenanceHostAction({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.actionRequest.expectedTaskRevision, signal: context.signal,
      }).actRollingSummaryProposal(step),
      // Lazy, source-bound host request/Verify, not a claim/Provider enable switch.
      publication: (context, step) => createAgentLoopMaintenanceHostPrepare({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.revision, signal: context.signal,
      }).publication(),
    },
    // Trusted host route only; the Service pre-claim gate below stays false.
    // This SAME Prepare capability selects MODEL without consumption, then the
    // original apply Action consumes it once. Provider output grants nothing.
    rollingSummaryApply: {
      prepare: (context, step) => createAgentLoopMaintenanceHostPrepare({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.revision, signal: context.signal,
      }).prepareRollingSummaryApply(step, context),
      decide: (context, step, capability) => createAgentLoopMaintenanceHostModel({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.revision, signal: context.signal,
      }, capability).decide(step),
      act: (context, step, capability) => createAgentLoopMaintenanceHostAction({
        runId: context.execution.job.runId, taskId: context.taskId, ownerId: context.ownerId,
        expectedRevision: step.actionRequest.expectedTaskRevision, signal: context.signal,
      }).actRollingSummaryApply(step, capability),
      completion: (context, step) => createAgentLoopMaintenanceHostApplyCompletion(context, step),
    },
  },
});
// Exact construction fact for this one production Runtime: the versioned
// correction-proposal factory and required-publication contract are captured,
// while their context-bound bundle/publication remain uninstantiated and grant
// no claim, execution, completion, publication, Canary or production authority.
const AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST =
  readAgentLoopServerCompositionCapabilityManifest(AGENT_LOOP_RUNTIME);
if (!AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST
  || !isAgentLoopServerCompositionCapabilityManifest(
    AGENT_LOOP_RUNTIME,
    AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST,
  )) throw new Error('agent-loop-production-capability-manifest-unbound');
// Read-only §13.84 observation only. Construction captures lazy callbacks and
// must not touch the Manager that is initialized later in this module.
const AGENT_LOOP_MAINTENANCE_PRODUCTION_JOB_READER =
  createMaintenanceProductionQueuedJobReaderInternal(
    () => maintenanceJobs,
    () => {
      if (!agentLoopManagerReadersReady) {
        throw new Error('agent-loop-maintenance-production-reader-not-ready');
      }
    },
  );
const AGENT_LOOP_MAINTENANCE_ADMISSION_READER =
  createAgentLoopMaintenanceCanaryAdmissionReaderInternal(
    () => AGENT_ADMISSION_LEDGER,
  );
const AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_READER =
  createAgentLoopMaintenanceCanarySourcePolicyReader({
    readJob: AGENT_LOOP_MAINTENANCE_PRODUCTION_JOB_READER,
    releaseOpen: () => agentLoopManagerReadersReady && releaseAdmissionOpen(),
    sessionOpen: (sessionId) => agentLoopManagerReadersReady
      && sessionDeletionAdmissionOpen(sessionId),
    maintenanceEnabled: (sessionId) => agentLoopManagerReadersReady
      && maintenanceJobs.settings(sessionId).effectiveEnabled,
    modeAllowed: (job) => agentLoopManagerReadersReady
      && maintenanceModelModeAllowed(MAINTENANCE_RUNTIME.enabled, MAINTENANCE_APPLY_RUNTIME, job),
    foregroundActive: (sessionId) => !agentLoopManagerReadersReady
      || turnJobs.getActiveForSession(sessionId) !== null,
    summarySkillConflict: (job) => !agentLoopManagerReadersReady
      || (maintenanceSummarySkillLiveEnabled(process.env)
        && maintenanceSummarySkillPolicyAllowed(job.policyVersion)),
    readAdmissions: AGENT_LOOP_MAINTENANCE_ADMISSION_READER,
    readSource: (sessionId) => {
      if (!agentLoopManagerReadersReady) return null;
      const session = sessions.get(sessionId);
      if (!session) return null;
      const snapshot = snapshotForSession(session);
      return {
        // The proof keeps this identity private and the production dispatcher
        // later requires this exact MemoryDb as its Session claim authority.
        sessionIdentity: session.getMemory().mem,
        sourceRevision: snapshot.snapshotToken,
        databaseRevision: snapshot.databaseRevision,
      };
    },
  });
/** Same bounded Context Builder for legacy execution and the non-authorizing AL preview. */
function buildRollingSummarySnapshotForSession(
  session: ChatSession, sessionId: string, revision: string,
  providerInput: Readonly<{ maxTokens: number; system: string }>,
) {
  const summaryState = session.getMemory().mem.db.prepare(
    "SELECT COALESCE(longterm,'') longterm,COALESCE(summary_round,0) summaryRound FROM memory_meta WHERE id=1",
  ).get() as { longterm: string; summaryRound: number } | undefined;
  return buildMaintenanceSessionSnapshot({ session, sessionId, revision, taskKind: 'rolling_summary',
    worldbookEntries: maintenanceWorldbookEntries(session),
    ...(summaryState ? { summaryState } : {}), providerInputBudget: providerInput });
}
/** Rebuild the same Arc source for initial loading and every live Skill authority check. */
function buildBranchIndexSnapshotForSession(
  session: ChatSession, sessionId: string, revision: string,
  providerInput: Readonly<{ maxTokens: number; system: string }>,
) {
  const learningArcProjection = AGENT_LEARNING_LEDGER
    ? selectArcSessionProjection(AGENT_LEARNING_LEDGER.arcSessionProjections(), session.learningProfileIdentity())
    : undefined;
  const approvedArcProjection = ARC_PROJECTIONS?.read(sessionId);
  const arcReviewBinding = bindArcMaintenanceReviewSnapshot({
    learningArcs: (learningArcProjection?.arcs ?? []).map((arc) => ({
      arcId: arc.arcId, status: arc.status, firstRound: arc.firstRound, lastRound: arc.lastRound,
      evidenceCount: arc.evidenceCount, latestSourceRevision: arc.latestSourceRevision,
    })),
    reviewCatalog: session.getArcReviewCatalog(),
    approvedStatuses: approvedArcProjection?.statuses,
    mergedInto: approvedArcProjection?.mergedInto,
  });
  return buildMaintenanceSessionSnapshot({ session, sessionId, revision, taskKind: 'branch_index',
    allowedArcIds: arcReviewBinding.allowedArcIds,
    arcProjectionDigest: approvedArcProjection?.projectionDigest,
    arcProjection: arcReviewBinding.arcEvidence,
    arcReviewCatalog: arcReviewBinding.arcReviewDescriptors,
    worldbookEntries: maintenanceWorldbookEntries(session), providerInputBudget: providerInput });
}
/** No Session loading, claim, Ticket, Client or model call. A preview is never an execution grant. */
function readAgentLoopMaintenancePrepareSource(runId: string): AgentLoopMaintenancePrepareSource | null {
  if (!agentLoopManagerReadersReady || !PROVIDER_SPI_ENABLED) return null;
  const job = maintenanceJobs.get(runId);
  const productionAdmission = AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission;
  const productionRouteSource = job?.taskKind === productionAdmission.taskKind
    && job.mode === productionAdmission.mode
    && job.trigger === productionAdmission.trigger
    && job.policyVersion === productionAdmission.policyVersion
    && isSafeOpaqueId(job.parentRunId);
  if (!job || job.taskKind !== 'rolling_summary' || (job.status !== 'queued' && job.status !== 'running')
    || (job.policyVersion !== MAINTENANCE_POLICY_VERSION && !productionRouteSource)
    || !sessionDeletionAdmissionOpen(job.sessionId)) return null;
  const session = sessions.get(job.sessionId);
  if (!session) return null;
  const revision = snapshotForSession(session).snapshotToken;
  if (revision !== job.sourceRevision) return null;
  const selection = resolveAgentSelection();
  const descriptor = providerRegistry.describe(selection.providerId);
  if (!descriptor?.configured || !descriptor.capabilities.chatCompletions || !descriptor.capabilities.tools) return null;
  // Public capabilities suffice here: do not construct a client just to inspect its profile.
  const runtimeProfile = resolveModelRuntimeProfile({ providerId: selection.providerId, modelId: selection.model,
    supportsTools: descriptor.capabilities.tools, supportsStreaming: descriptor.capabilities.stream });
  const budgetProfile = maintenanceBudgetProfileForAutonomy('quality-beta', 'rolling_summary', process.env, runtimeProfile);
  const snapshot = buildRollingSummarySnapshotForSession(session, job.sessionId, revision, {
    maxTokens: budgetProfile.agentInputBudgetTokens, system: maintenanceSystemPrompt('rolling_summary'),
  });
  if (!sessionDeletionAdmissionOpen(job.sessionId) || sessions.get(job.sessionId) !== session
    || snapshotForSession(session).snapshotToken !== revision) return null;
  return { job, snapshot, profile: { providerId: selection.providerId, modelId: selection.model,
    runtimeProfile, budgetProfile, policyVersion: job.policyVersion, contentMode: session.getContentMode() } };
}
const AGENT_LOOP_RECOVERY_LIFECYCLE = startAgentLoopRecoveryLifecycle({
  store: AGENT_LOOP_PROJECTION_STORE,
  ownerId: `server.${SERVER_INSTANCE_ID}`,
  leaseMs: 300_000,
  intervalMs: 60_000,
  limit: 32,
  runOnStart: false,
  shadowPublication: {
    readManager: () => agentLoopLegacySourceReady ? maintenanceJobs : null,
    clock: () => new Date().toISOString(),
  },
  summaryApplyCompletion: {
    readManager: () => agentLoopLegacySourceReady ? maintenanceJobs : null,
    clock: () => new Date().toISOString(),
  },
  sourceState: (envelope) => {
    // The periodic timer can fire during slow plugin startup. Do not touch TDZ
    // Managers or guess source liveness from a historical projection.
    if (!agentLoopLegacySourceReady) return 'unavailable';
    return shadowJobSourceState(envelope, {
      readTurnJob: (runId) => turnJobs.get(runId),
      readMaintenanceJob: (runId) => maintenanceJobs.get(runId),
    });
  },
});
let agentLoopProjectionStoreClosed = false;
let agentLoopTaskInvalidationDrainer: ReturnType<typeof createAgentLoopTaskInvalidationDrainer> | undefined;
function closeAgentLoopProjectionStore(): void {
  if (agentLoopProjectionStoreClosed) return;
  agentLoopProjectionStoreClosed = true;
  AGENT_LOOP_PROJECTION_STORE.close();
}
async function quiesceAgentLoopRecovery(): Promise<void> {
    await AGENT_LOOP_RECOVERY_LIFECYCLE.quiesce();
    await AGENT_LOOP_RUNTIME.close();
    await agentLoopTaskInvalidationDrainer?.stop();
    agentLoopManagerReadersReady = false;
    closeAgentLoopProjectionStore();
}
async function settleAgentLoopManagerReadersBeforeClose(): Promise<void> {
  // Both background readers may still hold a Manager reference.  Shutdown
  // first revokes the shared reader gate, then every Manager close joins both
  // already-published tails before closing the underlying DB.
  agentLoopManagerReadersReady = false;
  const settled = await Promise.allSettled([
    AGENT_LOOP_RECOVERY_LIFECYCLE.whenIdle(),
    AGENT_LOOP_RUNTIME.whenIdle(),
  ]);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}
process.once('exit', () => {
  AGENT_LOOP_RECOVERY_LIFECYCLE.stop();
  closeAgentLoopProjectionStore();
});

let providerConfigurationGeneration = 0;
/** 重新读取电脑端配置并更新 builtin descriptor；Key 只留在 controller 内。 */
function refreshProviderConfiguration(): ReturnType<typeof loadProviderConfig> {
  const cfg = loadProviderConfig();
  const descriptor = openAIProvider.rebind(cfg);
  providerConfigurationGeneration++;
  if (PROVIDER_SPI_ENABLED) providerRegistry.updateDescriptor(PROVIDER_OWNER_ID, descriptor);
  for (const session of sessions.values()) {
    try { session.rebindProvider(cfg); } catch { /* 单个会话刷新失败不阻塞配置提交 */ }
  }
  return cfg;
}

function providerClientForServer(selection?: { readonly providerId: string; readonly model: string }) {
  if (!PROVIDER_SPI_ENABLED) return undefined;
  if (!selection) return registryProviderClient;
  const fixedSelection = Object.freeze({ providerId: selection.providerId, model: selection.model });
  return createRegistryProviderClient({ registry: providerRegistry, resolveSelection: () => fixedSelection });
}

/** Capture transport, identity and usage attribution together before each Session request queues. */
/** Exact-session, opt-in operation accounting. All limits/rates must be supplied by the host. */
let serverSessionProviderRuntime: ReturnType<typeof createSessionProviderRuntime> | undefined;
function sessionProviderRuntime(): ReturnType<typeof createSessionProviderRuntime> {
  return serverSessionProviderRuntime ??= createSessionProviderRuntime({ env: process.env,
    providerSpiEnabled: PROVIDER_SPI_ENABLED, operationBudgetStore: () => turnJobs.manager.operationBudgetStore(),
    loadProviderConfig, assertProviderReady, createDirectProviderClient: config => new OpenAICompatibleClient(config),
    agentModelBinding, modelRuntimeProfileFor, providerClientForServer,
    registryProviderClient, providerRegistry, readProviderGeneration: () => providerConfigurationGeneration,
    observeServerModelClient, resolvedArbitratedAgentClient, skillFulfillmentForSession,
    schemaRepairDispatchForSession: rawSessionId => {
      return createSchemaRepairAdmittedDispatcher({
        readContext: createSchemaRepairContextReader(() => sessions.get(rawSessionId),
          () => sessionDeletionAdmissionOpen(rawSessionId)),
        admissionAvailable: () => !!AGENT_ADMISSION_LEDGER && !!MODEL_USAGE_COST,
        authorize: sessionId => agentTicketControl({ sessionId, lane: 'critic', taskKind: 'critic_revision',
          policyVersion: 'p14-skill-fulfillment-v1' }) !== false,
        broker: AGENT_ADMISSION_BROKER, audit: recordAgentRuntimeLease,
      });
    },
    schemaRepairEvidence: (sessionId, value) => {
      if (turnJobs.get(value.runId)) {
        try { turnJobs.manager.saveRepairEvidence(sessionId, value.runId, value.candidateDigest, value.evidence); }
        catch (cause) { throw new Error('schema-repair-evidence-storage-failed', { cause }); }
      }
    },
    reportProgress: (sessionId, runId, phase) => turnJobs.reportProgress(sessionId, runId, phase),
  });
}
function turnOperationClientForServer(sessionId: string, runId: string | undefined,
  phase: TurnOperationPhase, client: ChatCompletionClient): ChatCompletionClient {
  return sessionProviderRuntime().turnOperationClientForServer(sessionId, runId, phase, client);
}

/** Exact-session W4 host; all four lanes remain in the same parent operation. */
function skillFulfillmentForSession(rawSessionId: string, operation: ReturnType<typeof createTurnOperationHost>) {
  return createSkillFulfillmentSessionHost({
    getSession: sessionId => sessions.get(sessionId),
    admissionAvailable: () => !!AGENT_ADMISSION_LEDGER && !!MODEL_USAGE_COST,
    sessionDeletionAdmissionOpen,
    readStages: () => process.env.JG_SKILL_FULFILLMENT_STAGES_JSON,
    agentModelBinding,
    mainSelection: () => { const config = loadProviderConfig(); return { providerId: config.providerId, model: config.model }; },
    arbitratedAgentClient,
    broker: AGENT_ADMISSION_BROKER,
    authorizeLease: (sessionId, phase) => agentTicketControl({ sessionId,
      lane: phase === 'requirements' ? 'interactive' : 'critic',
      taskKind: phase === 'requirements' ? 'interactive_prelude' : 'critic_revision',
      policyVersion: 'p14-skill-fulfillment-v1' }) !== false,
    audit: recordAgentRuntimeLease,
  }, rawSessionId, operation);
}

/** Keep SPI-off's legacy fallback policy while decorating its internally selected transport. */
function sessionProviderArgsForServer(sessionId: string): Pick<SessionArgs, 'providerClient' | 'observeProviderClient' | 'turnOperation' | 'skillFulfillment' | 'onTurnProgress' | 'onRejectedTurnCandidate' | 'schemaRepair' | 'schemaRepairMode'> {
  return { ...sessionProviderRuntime().sessionProviderArgsForServer(sessionId),
    onRejectedTurnCandidate: ({ runId, candidate }) => {
      // Some internal Session callers have no TurnJob; only job-owned turns have this store.
      if (turnJobs.get(runId)) turnJobs.manager.saveCandidate(sessionId, runId, candidate);
    } };
}

const SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG = parseAgentSkillShadowRuntimeConfig();
const STYLE_PACKAGE_SHADOW_ENABLED = SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.enabled
  && SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.allowedSkillIds.includes(STYLE_PACKAGE_SHADOW_PIN.skillId);
const STYLE_PACKAGE_SHADOW = createStylePackageShadowObserver({
  directory: resolve(DATA_DIR, 'skills'), isEnabled: () => STYLE_PACKAGE_SHADOW_ENABLED,
});
const SESSION_AGENT_SKILL_SHADOW_METRICS = new SessionAgentSkillShadowMetrics();
const SESSION_AGENT_SKILL_SHADOW_HEALTH_WINDOW = new SessionAgentSkillShadowHealthWindow();
const SESSION_AGENT_SKILL_SHADOW_CATALOG = new CachedLegacyAgentSkillCatalogResolver({
  load: () => createFilesystemLegacyAgentSkillCatalogAdapter({
    allowedRootSkillIds: SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.allowedSkillIds,
  }),
  ttlMs: 5_000,
});
const SESSION_AGENT_SKILL_SHADOW_DELEGATE = createSessionAgentSkillShadowObserver({
  allowedRootSkillIds: SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.allowedSkillIds,
  resolveCatalog: () => SESSION_AGENT_SKILL_SHADOW_CATALOG.resolve(),
  audit: (entry) => {
    // The runner/cache only expose process-lifetime counters and do not know which catalog they
    // serve. Rotate from the previous successful-audit checkpoint when a new revision first audits.
    const runner = SESSION_AGENT_SKILL_SHADOW_RUNNER.snapshot();
    const catalog = SESSION_AGENT_SKILL_SHADOW_CATALOG.snapshot();
    SESSION_AGENT_SKILL_SHADOW_HEALTH_WINDOW.recordSuccessfulAudit(entry.catalogRevision, {
      failed: runner.failed,
      dropped: runner.dropped,
      catalogRefreshFailures: catalog.refreshFailures,
    });
    SESSION_AGENT_SKILL_SHADOW_METRICS.record(entry);
  },
});
const SESSION_AGENT_SKILL_SHADOW_RUNNER = new SessionAgentSkillShadowRunner(
  { async observe(input) {
    await SESSION_AGENT_SKILL_SHADOW_DELEGATE.observe(input);
    if (STYLE_PACKAGE_SHADOW_ENABLED) await STYLE_PACKAGE_SHADOW.observe(input);
  } },
  { staleAfterMs: 120_000 },
);
function skillSelectionObserverForSession(rawSessionId: string): SessionArgs['skillSelectionObserver'] {
  return SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.allowsSession(rawSessionId)
    ? SESSION_AGENT_SKILL_SHADOW_RUNNER
    : undefined;
}
const STYLE_PACKAGE_PIN_STORE = new SkillPackagePinStore({ dataDir: DATA_DIR });
const STYLE_PACKAGE_CANARY = createStylePackageCanary({
  directory: resolve(DATA_DIR, 'skills'), controlFile: resolve(DATA_DIR, STYLE_PACKAGE_CANARY_FILE),
  shadow: STYLE_PACKAGE_SHADOW, runner: SESSION_AGENT_SKILL_SHADOW_RUNNER,
  controlStore: STYLE_PACKAGE_PIN_STORE, writesEnabled: skillPromotionWritesEnabled,
  allowsSession: sessionId => STYLE_PACKAGE_SHADOW_ENABLED && SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.allowsSession(sessionId),
});

/** Resolve one exact provider/model profile at a ticket boundary; callers keep that immutable
 * value for budget derivation and ticket issuance instead of observing a mid-call UI switch. */
function modelRuntimeProfileFor(
  cfg: { readonly providerId: string; readonly model: string },
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
function observeServerModelClient(
  client: ChatCompletionClient,
  resolveProviderId: () => string = () => loadProviderConfig().providerId,
): ChatCompletionClient {
  return new ObservedChatCompletionClient(client, {
    record: (entry) => { MODEL_USAGE_LEDGER.record(entry); },
    resolveProviderId,
    estimateCost: MODEL_USAGE_COST,
    onRecordError: () => {
      if (modelUsageRecordWarningEmitted) return;
      modelUsageRecordWarningEmitted = true;
      console.warn('[ModelUsage] MODEL_USAGE_RECORD_FAILED（正文链继续运行）');
    },
  });
}

function skillAuthorWorkflowModelContext(taskKind: 'skill_compile' | 'skill_evaluate' | 'skill_sample') {
    if (!PROVIDER_SPI_ENABLED || !MODEL_USAGE_COST || !AGENT_ADMISSION_LEDGER) return null;
    try {
        const binding = agentModelBinding();
        const profile = modelRuntimeProfileFor(binding.selection, binding.client);
        if (binding.client.capabilities?.().tools !== true) return null;
        const budgetProfile = agentTaskBudgetProfile(taskKind, process.env, {}, profile);
        // Only this digest persists: keys, endpoint configuration and descriptors never enter the job or prompt.
        const modelBindingDigest = 'sha256:' + createHash('sha256').update(JSON.stringify({
            selection: binding.selection, profile, budgetProfile,
            descriptor: providerRegistry.describe(binding.selection.providerId),
            configurationDigest: createHash('sha256').update(JSON.stringify(loadProviderConfig())).digest('hex'),
        })).digest('hex');
        return {
            broker: AGENT_ADMISSION_BROKER,
            client: arbitratedAgentClient(binding.client, binding.selection,
                taskKind === 'skill_compile' ? 'style-compile' : 'quality-judge'),
            modelId: binding.selection.model,
            providerId: binding.selection.providerId, modelBindingDigest, budgetProfile, auditRequired: true,
            onLeaseClosed: (entry: AdmittedModelLeaseAudit) => recordAgentRuntimeLease(entry, false),
            estimateCostMicrousd: (usage: Parameters<NonNullable<typeof MODEL_USAGE_COST>>[0],
                call: Parameters<NonNullable<typeof MODEL_USAGE_COST>>[1]) => MODEL_USAGE_COST!(usage, call)?.costMicrousd,
        };
    } catch { return null; }
}

function skillAuthorWorkflowSourceAllowed(
    rawSessionId: string, taskKind: 'skill_compile' | 'skill_evaluate' | 'skill_sample' | 'skill_quality',
) {
    if (!sessionDeletionAdmissionOpen(rawSessionId)
        || !agentAdmissionAllowsSession(parseAgentAdmissionRuntimeConfig(process.env), rawSessionId)) return false;
    if (agentTicketControl({
        sessionId: rawSessionId, lane: 'learning', taskKind,
        policyVersion: taskKind === 'skill_compile' ? SKILL_COMPILE_POLICY_VERSION
            : taskKind === 'skill_evaluate' ? SKILL_EVALUATE_POLICY_VERSION
            : taskKind === 'skill_sample' ? SKILL_SAMPLE_POLICY_VERSION : SKILL_QUALITY_POLICY_VERSION,
    }) === false) return false;
    const path = resolveSessionDatabase(DATA_DIR, rawSessionId + '.db');
    return path !== null && existsSync(path);
}

const SKILL_COMPILE_RUNTIME = openSkillCompileRuntime({
    dataDir: DATA_DIR, candidates: AGENT_SKILL_CANDIDATE_RUNTIME, enabled: skillCompileEnabled,
    resolveModel: () => skillAuthorWorkflowModelContext('skill_compile'),
    sourceAllowed: (rawSessionId) => skillAuthorWorkflowSourceAllowed(rawSessionId, 'skill_compile'),
    isSessionDeleted: (rawSessionId) => SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
    onFailure: (code) => console.warn('[AgentSkillCompile] ' + code + '（原Agent继续，模型不重放）'),
});

const SKILL_EVALUATE_RUNTIME = openSkillEvaluateRuntime({
    dataDir: DATA_DIR, enabled: skillEvaluateEnabled,
    resolveModel: () => skillAuthorWorkflowModelContext('skill_evaluate'),
    sourceAllowed: (rawSessionId) => skillAuthorWorkflowSourceAllowed(rawSessionId, 'skill_evaluate'),
    resolvePlan: (compileJobId) => {
        const source = SKILL_COMPILE_RUNTIME?.readEvaluationInput(compileJobId);
        return source ? createSkillEvaluatePlan(source) : null;
    },
    isSessionDeleted: (rawSessionId) => SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
    onFailure: (code) => console.warn('[AgentSkillEvaluate] ' + code + '（原Agent继续，模型不重放）'),
});

const CANDIDATE_EVALUATION_SAMPLE_HOST = new CandidateEvaluationSampleHost({
    dataDir: DATA_DIR,
    resolveCurrent: (compileJobId) => {
        const retained = SKILL_COMPILE_RUNTIME?.readEvaluationInput(compileJobId);
        const model = skillAuthorWorkflowModelContext('skill_sample');
        if (!retained || !model) return null;
        return {
            evaluatePlan: createSkillEvaluatePlan(retained),
            modelId: model.modelId,
            modelBindingDigest: model.modelBindingDigest,
            budgetProfile: model.budgetProfile,
        };
    },
    isSessionDeleted: (rawSessionId) => SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
});

const SKILL_SAMPLE_RUNTIME = openSkillSampleRuntime({
    dataDir: DATA_DIR, enabled: skillSampleEnabled, suiteEnabled: skillSampleSuiteEnabled,
    resolveModel: () => skillAuthorWorkflowModelContext('skill_sample'),
    sourceAllowed: (rawSessionId) => skillAuthorWorkflowSourceAllowed(rawSessionId, 'skill_sample'),
    resolvePlan: (compileJobId) => {
        const source = SKILL_COMPILE_RUNTIME?.readEvaluationInput(compileJobId);
        return source ? createSkillSamplePlan(createSkillEvaluatePlan(source)) : null;
    },
    resolveCompletedPlan: (compileJobId) => {
        const source = SKILL_COMPILE_RUNTIME?.readCompletedEvidenceInput(compileJobId);
        return source ? createSkillSamplePlan(createSkillEvaluatePlan(source)) : null;
    },
    resolveDispatchSidecarFactory: (input) => CANDIDATE_EVALUATION_SAMPLE_HOST.resolve(input),
    isSessionDeleted: (rawSessionId) => SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
    onFailure: (code) => console.warn('[AgentSkillSample] ' + code + '（原Agent继续，模型不重放）'),
});

function skillQualityAuthorityForSource(source: SkillSampleQualityInput) {
    if (credentialLockdownActive()) return null;
    const generation = skillAuthorWorkflowModelContext('skill_sample');
    if (!generation || generation.modelId !== source.generation.modelId
        || generation.modelBindingDigest !== source.generation.modelBindingDigest) return null;
    const resolved = resolveSkillQualityAuthority({
        env: process.env,
        generation: {
            providerId: generation.providerId,
            modelId: generation.modelId,
            modelBindingDigest: generation.modelBindingDigest,
        },
        broker: AGENT_ADMISSION_BROKER,
        estimateCostMicrousd: generation.estimateCostMicrousd,
        onLeaseClosed: generation.onLeaseClosed,
        describeProvider: (providerId) => providerRegistry.describe(providerId),
        createClient: (selection) => {
            const client = createRegistryProviderClient({
                registry: providerRegistry,
                resolveSelection: () => ({ providerId: selection.providerId, model: selection.model }),
            });
            return observeServerModelClient(client, () => selection.providerId);
        },
        resolveModelProfile: (selection, client) => modelRuntimeProfileFor(selection, client),
    });
    return resolved ? Object.freeze({
        generation: resolved.generation,
        judges: resolved.judges,
        perJudgeBudgetDigest: resolved.perJudgeBudgetDigest,
    }) : null;
}

const SKILL_QUALITY_RUNTIME = openSkillQualityRuntime({
    dataDir: DATA_DIR,
    enabled: skillQualityEnabled,
    sourceAllowed: (rawSessionId) => skillAuthorWorkflowSourceAllowed(rawSessionId, 'skill_quality'),
    resolveSource: (sampleSuiteId) => SKILL_SAMPLE_RUNTIME?.readQualityInput(sampleSuiteId) ?? null,
    resolveCompletedSource: (sampleSuiteId) => SKILL_SAMPLE_RUNTIME?.readCompletedQualityInput(sampleSuiteId) ?? null,
    resolveAuthority: skillQualityAuthorityForSource,
    isSessionDeleted: (rawSessionId) => SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
    onFailure: (code) => console.warn('[AgentSkillQuality] ' + code + '（原Agent继续，模型不重放）'),
});

/**
 * P17 D-Q3a2c：Channel 发布写权限的显式开关（默认关闭）。
 * 关着的时候：库不存在 ⇒ 路由 503 且不建库；库已存在 ⇒ 只读可用（体检/指针/历史），
 * `promote` / `retire` 一律 `skill-promotion-disabled`。
 */
function skillPromotionWritesEnabled(): boolean {
    return process.env.JG_SKILL_PROMOTION_STORES === '1';
}

/**
 * P17 D-Q3a2b2：Candidate 评测批次库（发布侧汇合的证据源）。默认不建库：
 * 只有显式 opt-in 或库已存在时才打开。
 *
 * `sourceCurrent` 逐次复验会话、Candidate/source revision、当前模型绑定与预算 epoch；
 * 任一漂移都会触发 Store 的单调 revocation，旧批次不会复活。
 * join 本身另有独立校验：Sample/Quality 的 suite 摘要必须逐字相等，候选必须 validated/rev2。
 */
const SKILL_EVALUATION_BATCH_STORE = (skillPromotionWritesEnabled()
    || existsSync(resolve(DATA_DIR, CANDIDATE_EVALUATION_BATCH_DB_FILE)))
    ? new CandidateEvaluationBatchStore({
        dataDir: DATA_DIR,
        isSessionDeleted: (rawSessionId) => SESSION_DELETION_JOURNAL.isBlocked(rawSessionId),
        sourceCurrent: (source) => {
            if (SESSION_DELETION_JOURNAL.isBlocked(source.rawSessionId)) return false;
            const candidate = AGENT_SKILL_CANDIDATE_RUNTIME?.readCandidate(source.candidateId)?.candidate;
            const model = skillAuthorWorkflowModelContext('skill_sample');
            if (!candidate || !model || source.compileJobId === null || source.sampleSuiteId === null) {
                return false;
            }
            const retained = SKILL_COMPILE_RUNTIME?.readCompletedEvidenceInput(source.compileJobId);
            if (!retained) return false;
            try {
                const currentCompileSource = candidateEvaluationSampleSourceFromCurrent({
                    evaluatePlan: createSkillEvaluatePlan(retained),
                    sampleSuiteId: source.sampleSuiteId,
                    modelId: model.modelId,
                    modelBindingDigest: model.modelBindingDigest,
                    budgetProfile: model.budgetProfile,
                });
                return candidateEvaluationCompletedSourceIdentityCurrent({
                    source,
                    currentCompileSource,
                    candidate,
                    modelId: model.modelId,
                    modelBindingDigest: model.modelBindingDigest,
                    budgetProfile: model.budgetProfile,
                });
            } catch { return false; }
        },
    })
    : null;

const SKILL_PROMOTION_RUNTIME = openSkillPromotionRuntime({
    dataDir: DATA_DIR,
    enabled: skillPromotionWritesEnabled,
    styleCompileLiveEnabled: () => styleCompileSkillLiveEnabled(process.env),
    // 裁决由 Quality 的离线回执确定性重算；只读、不含正文。
    readQualityReceipt: (suiteId) => SKILL_QUALITY_RUNTIME?.readOfflineReceipt(suiteId) ?? null,
    // 三源汇合：Sample 存储层 suite × Candidate 批次 × Quality 存储层 suite。
    // 任一 runtime 未启用时对应端口返回 null，join 会以 source-missing 失败（不猜）。
    joinPorts: {
        readSampleSuite: (suiteId) => SKILL_SAMPLE_RUNTIME?.readStoredSuite(suiteId) ?? null,
        readQualitySuite: (suiteId) => SKILL_QUALITY_RUNTIME?.readCompletedEvidenceSuite(suiteId) ?? null,
        readBatch: (batchId) => SKILL_EVALUATION_BATCH_STORE?.readBatch(batchId)
            ?? CANDIDATE_EVALUATION_SAMPLE_HOST.readBatch(batchId),
        readBatchReadOnly: (batchId) => SKILL_EVALUATION_BATCH_STORE?.readCurrentBatchWithoutRevocation(batchId) ?? null,
        listBatches: (candidateId, cursor) => {
            if (!SKILL_EVALUATION_BATCH_STORE) throw new Error('skill-evidence-discovery-unavailable');
            return SKILL_EVALUATION_BATCH_STORE.listCompletedForCandidate(candidateId, cursor);
        },
        listQualities: (sampleSuiteId, cursor) => {
            if (!SKILL_QUALITY_RUNTIME) throw new Error('skill-evidence-discovery-unavailable');
            return SKILL_QUALITY_RUNTIME.listCompletedEvidenceForSample(sampleSuiteId, cursor);
        },
    },
    onFailure: (code) => console.warn('[AgentSkillPromotion] ' + code + '（发布面保持不可用）'),
});

function interactiveHarnessForSession(
  rawSessionId: string,
): import('../../packages/session/src/session.ts').SessionArgs['interactiveHarness'] {
  if (!INTERACTIVE_RUNTIME.enabled || INTERACTIVE_RUNTIME.lane === 'off' || !INTERACTIVE_CALL_LEDGER) return undefined;
  let runtimeProfile: ReturnType<typeof modelRuntimeProfileFor>;
  try {
    const binding = agentModelBinding();
    runtimeProfile = modelRuntimeProfileFor(binding.selection, binding.client);
  } catch {
    // Keep the harness recoverable after a later config repair, but the per-turn
    // resolveRuntime below still fails closed while the Agent selection is invalid.
    runtimeProfile = modelRuntimeProfileFor(loadProviderConfig(), registryProviderClient);
  }
  const budgetProfile = interactiveBudgetProfileForAutonomy(
    INTERACTIVE_RUNTIME.budgetProfile!.autonomyProfile,
    process.env,
    runtimeProfile,
  );
  return {
    resolveRuntime: () => {
      const current = agentModelBinding();
      const transport = arbitratedAgentClient(current.client, current.selection, 'interactive-prelude');
      const operationHost = sessionProviderRuntime().activeHostForSession(rawSessionId);
      const client: ChatCompletionClient = operationHost ? {
        complete: (request, signal, call) => {
          if (request.model !== undefined && request.model !== current.selection.model) throw new Error('turn-operation-model-mismatch');
          if (!call?.runId) throw new Error('turn-operation-run-required');
          return operationHost.wrap(call.runId, 'prelude', transport)
            .complete({ ...request, model: current.selection.model }, signal, call);
        },
        stream: (request, onDelta, onToolArg, signal, call) => {
          if (request.model !== undefined && request.model !== current.selection.model) throw new Error('turn-operation-model-mismatch');
          if (!call?.runId) throw new Error('turn-operation-run-required');
          return operationHost.wrap(call.runId, 'prelude', transport)
            .stream({ ...request, model: current.selection.model }, onDelta, onToolArg, signal, call);
        },
        ...(transport.capabilities ? { capabilities: transport.capabilities.bind(transport) } : {}),
        modelName: () => current.selection.model,
      } : transport;
      return {
        client,
        budgetProfile: interactiveBudgetProfileForAutonomy(
          INTERACTIVE_RUNTIME.budgetProfile!.autonomyProfile,
          process.env,
          modelRuntimeProfileFor(current.selection, current.client),
        ),
      };
    },
    lane: INTERACTIVE_RUNTIME.lane,
    budgetProfile,
    inputMicrousdPerMillionTokens: INTERACTIVE_RUNTIME.inputMicrousdPerMillionTokens!,
    outputMicrousdPerMillionTokens: INTERACTIVE_RUNTIME.outputMicrousdPerMillionTokens!,
    variableSpecs: INTERACTIVE_RUNTIME.variableSpecs,
    audit: (entry) => { INTERACTIVE_CALL_LEDGER.record(entry, { sessionId: rawSessionId }); },
  };
}

type StyleProposalInput = Parameters<NonNullable<NonNullable<SessionArgs['agentAdmission']>['requestStyleProposal']>>[0];
type StyleProposalOutcome = Awaited<ReturnType<NonNullable<NonNullable<SessionArgs['agentAdmission']>['requestStyleProposal']>>>;
type PreparedStyleProposalOutcome = Exclude<StyleProposalOutcome, { status: 'created' }>
  | Readonly<{ status: 'prepared'; commit(): StyleProposalOutcome }>;

/** Ephemeral binding only: never persist endpoint configuration or credentials in a Style job. */
function styleProposalModelBindingDigest(
  selection: ReturnType<typeof agentModelBinding>['selection'],
  client: ChatCompletionClient,
  budgetProfile: ReturnType<typeof agentTaskBudgetProfile>,
): string {
  return sha256Digest(JSON.stringify({
    selection, profile: modelRuntimeProfileFor(selection, client), budgetProfile,
    descriptor: providerRegistry.describe(selection.providerId),
    configurationDigest: sha256Digest(JSON.stringify(loadProviderConfig())),
  }));
}

/** A host configuration snapshot, never a dispatch ticket or permission to retry. */
function captureStyleCompileBindingForSession(rawSessionId: string, contentMode: 'nsf' | 'nsfw'):
  import('../../packages/memory/public/style-compile-intent-outbox.ts').StyleCompileBinding | null {
  try {
    if (!sessions.get(rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId) || !MODEL_USAGE_COST) return null;
    const admission = parseAgentAdmissionRuntimeConfig(process.env);
    const privacy = parseLearningTextRuntimeConfig(process.env);
    if (!privacy.styleEnabled || !agentAdmissionAllowsSession(admission, rawSessionId)
      || !agentCapabilityTicketAllowed(AGENT_CONTROL_STORE, {
        taskKind: 'style_compile', policyVersion: 'p14-q7-style-compiler-v1' })) return null;
    const runtime = parseAgentLaneRuntimeConfig(process.env);
    const control = AGENT_CONTROL_STORE.get('learning');
    const ticketSessionId = opaqueLearningToken('session', rawSessionId);
    const decision = evaluateAgentLaneRollout({ lane: 'learning',
      sessionId: runtime.managed ? agentLaneRolloutBucketIdentity(runtime, ticketSessionId) : ticketSessionId,
      desiredState: runtime.managed ? control.desiredState : 'on',
      hostCeiling: runtime.managed ? runtime.ceilings.learning : 'on',
      evidence: AGENT_CONTROL_STORE.evidence('learning'),
    });
    if (control.desiredState === 'killed' || decision.shouldKill || (runtime.managed && !decision.allowed)) return null;
    const model = agentModelBinding();
    const profile = modelRuntimeProfileFor(model.selection, model.client);
    const budget = agentTaskBudgetProfile('style_compile', process.env, {}, profile);
    return normalizeStyleCompileBinding({ version: 'style-compile-binding-v1',
      policyVersion: 'p14-q7-style-compiler-v1', providerId: model.selection.providerId, modelId: model.selection.model,
      authorityDigest: sha256Digest(JSON.stringify({ version: 'style-runtime-authority-v1', ticketSessionId, contentMode,
        admission: { mode: admission.mode, sessionScope: admission.sessionScope,
          sessionAllowlist: [...admission.sessionAllowlist].sort() },
        styleEnabled: privacy.styleEnabled, managed: runtime.managed,
        cohort: runtime.cohort,
        rolloutIdentity: runtime.managed ? agentLaneRolloutBucketIdentity(runtime, ticketSessionId) : ticketSessionId,
        desiredState: control.desiredState, ceiling: runtime.managed ? runtime.ceilings.learning : 'on',
      })),
      modelBindingDigest: styleProposalModelBindingDigest(model.selection, model.client, budget),
      modelProfileDigest: sha256Digest(JSON.stringify(profile)), budgetProfileDigest: agentBudgetProfileDigest(budget),
    });
  } catch { return null; }
}

/** Model work is read-only; only the returned synchronous commit may create a disabled proposal. */
async function prepareStyleProposalForSession(
  rawSessionId: string, candidate: StyleProposalInput,
  execution?: Readonly<{ store: StyleCompileJobStore; job: import('./skill-hub/style-compile-job-store.ts').StyleCompileJobRecord }>,
): Promise<PreparedStyleProposalOutcome> {
  // The caller retains its arguments across await: do not let aliases change ownership or evidence.
  let input: StyleProposalInput;
  try {
    input = Object.freeze({ ...candidate,
      samples: Object.freeze(candidate.samples.map((sample) => Object.freeze({ ...sample }))),
      forbiddenIdentityTerms: Object.freeze([...candidate.forbiddenIdentityTerms]),
      scope: Object.freeze({ ...candidate.scope }),
      ...(candidate.originalBinding !== undefined
        ? { originalBinding: normalizeStyleCompileBinding(candidate.originalBinding) } : {}),
    });
  } catch { return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' }); }
  let liveAdmission;
  let livePrivacy;
  try {
    liveAdmission = parseAgentAdmissionRuntimeConfig(process.env);
    livePrivacy = parseLearningTextRuntimeConfig(process.env);
  } catch {
    return Object.freeze({ status: 'skipped', reasonCode: 'style-runtime-config-invalid' });
  }
  const sampleChars = input.samples.reduce((sum, sample) => sum + sample.prose.length, 0);
  const pilot = STYLE_COMPILE_RUNTIME_CONFIG.pilot;
  if (!livePrivacy.styleEnabled || !agentAdmissionAllowsSession(liveAdmission, rawSessionId)
    || (pilot && rawSessionId !== pilot.sessionId)
    || input.rawSessionId !== rawSessionId || input.signal?.aborted
    || input.runId === 'missing-run' || !MODEL_USAGE_COST
    || input.samples.length < 1 || input.samples.length > 8 || sampleChars > 100_000) {
    return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' });
  }
  const authority = styleProposalSourceAuthority(rawSessionId, input);
  if (!authority) return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' });
  const originalBindingCurrent = (): boolean => !input.originalBinding
    || JSON.stringify(captureStyleCompileBindingForSession(rawSessionId, input.contentMode)) === JSON.stringify(input.originalBinding);
  if (!originalBindingCurrent()) return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' });
  const { selection: provider, client: rawStyleClient } = agentModelBinding();
  const budgetProfile = agentTaskBudgetProfile(
    'style_compile', process.env, {}, modelRuntimeProfileFor(provider, rawStyleClient),
  );
  const bindingDigest = styleProposalModelBindingDigest(provider, rawStyleClient, budgetProfile);
  if (pilot && (provider.providerId !== pilot.providerId || provider.model !== pilot.modelId)) {
    return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' });
  }
  if (input.originalBinding && input.originalBinding.modelBindingDigest !== bindingDigest) {
    return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' });
  }
  let styleSkillSource: StyleCompileSkillSourceSnapshotV1 | null = null;
  const stillAuthorized = (): boolean => {
    try {
      if (input.signal?.aborted || !parseLearningTextRuntimeConfig(process.env).styleEnabled
        || !agentAdmissionAllowsSession(parseAgentAdmissionRuntimeConfig(process.env), rawSessionId)
        || !originalBindingCurrent()
        || (styleSkillSource !== null && !isStyleCompileSkillSourceCurrent(styleSkillSource))) return false;
      if (pilot && (!styleCompileBackgroundAllowed()
        || parseStyleCompileRuntimeConfig(process.env).pilot?.policyDigest !== pilot.policyDigest
        || Date.now() >= Date.parse(pilot.expiresAt))) return false;
      const current = styleProposalSourceAuthority(rawSessionId, input);
      if (!current || current.session !== authority.session || current.sourceDigest !== authority.sourceDigest) return false;
      const model = agentModelBinding();
      const budget = agentTaskBudgetProfile('style_compile', process.env, {},
        modelRuntimeProfileFor(model.selection, model.client));
      return styleProposalModelBindingDigest(model.selection, model.client, budget) === bindingDigest;
    } catch { return false; }
  };
  // Only the original executing durable job may acquire the new Style source. Legacy sync remains unchanged.
  const styleSkillRequested = Boolean(execution && styleCompileSkillLiveEnabled(process.env));
  if (styleSkillRequested && !AGENT_CLOSURE_STORE) {
    return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' });
  }
  if (styleSkillRequested && execution) {
    try {
      styleSkillSource = captureStyleCompileSkillSource({ rawSessionId, session: authority.session,
        store: execution.store, job: execution.job, input,
        isSessionOpen: () => sessionDeletionAdmissionOpen(rawSessionId) && sessions.get(rawSessionId) === authority.session });
    } catch { return Object.freeze({ status: 'skipped', reasonCode: 'style-admission-closed' }); }
  }
  // P17-01.3: arbitration owns background preemption and the physical Provider lifetime.
  const pilotClient = pilot ? createStyleCompilePilotClient({ client: rawStyleClient, policy: pilot,
    rawSessionId, providerId: provider.providerId, modelId: provider.model,
    reservationDigest: sha256Digest(JSON.stringify(['style-pilot-call-v1', rawSessionId, input.runId,
      input.sourceRevision, input.sourceDigest])), maxInputTokens: budgetProfile.agentInputBudgetTokens,
    isCurrent: stillAuthorized,
    reserve: (reservation) => {
      if (!STYLE_COMPILE_RUNTIME) throw new Error('style-pilot-runtime-closed');
      STYLE_COMPILE_RUNTIME.reservePilotBudget(reservation);
    },
    halt: (pilotIdDigest) => {
      if (!STYLE_COMPILE_RUNTIME) throw new Error('style-pilot-runtime-closed');
      STYLE_COMPILE_RUNTIME.haltPilotBudget(pilotIdDigest);
    },
  }) : rawStyleClient;
  let styleDispatchLease: import('./agent-admission-broker.ts').AgentAdmissionLease | null = null;
  const client = styleSkillRequested
    ? arbitratedAgentClient(pilotClient, provider, 'style-compile', undefined, () => {
      if (!stillAuthorized() || !styleDispatchLease || skillHost?.authorizeDispatch(styleDispatchLease) !== true
        || skillCall?.authorizeFixedRequest() !== true) throw new Error('style-skill-source-current-lost');
    })
    : arbitratedAgentClient(pilotClient, provider, 'style-compile');
  const modelRequest = buildStyleCompilationModelRequest({
    profileVersion: input.profileVersion, samples: input.samples,
    maxOutputTokens: budgetProfile.agentOutputBudgetTokens,
  });
  const tools = [...(modelRequest.tools ?? [])];
  const fixedRequest = { ...modelRequest, model: provider.model };
  let skillCall: ReturnType<typeof createStyleCompileSkillLiveCall> | null = null;
  let skillHost: ReturnType<typeof createStyleCompileSkillHostAuthority> | null = null;
  if (styleSkillSource) {
    const source = styleSkillSource;
    skillHost = createStyleCompileSkillHostAuthority({ source, broker: AGENT_ADMISSION_BROKER,
      controlStore: AGENT_CONTROL_STORE, readLaneRuntime: () => parseAgentLaneRuntimeConfig(process.env),
      readEligibility: (lease) => ({ allowed: stillAuthorized() && lease.budgetProfileDigest === agentBudgetProfileDigest(budgetProfile),
        revision: bindingDigest }), liveEnabled: () => styleCompileSkillLiveEnabled(process.env),
      safetyAuthority: { readForLease: (lease, current) => {
        const dbPath = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
        return dbPath ? { sessionId: lease.sessionId, sourceRevision: current.sourceRevision,
          state: NSFW_SCENE_SAFETY_CONTROL.read({ dbPath, sessionId: rawSessionId,
            manifest: authority.session.getWorldbookSourceManifest() }) } : null;
      } },
    });
    skillCall = createStyleCompileSkillLiveCall({ broker: AGENT_ADMISSION_BROKER, source,
      authority: skillHost.authority, profileVersion: input.profileVersion, samples: input.samples, request: fixedRequest });
  }
  const estimateCost = MODEL_USAGE_COST;
  const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, client, {
    estimateCostMicrousd: (usage, call) => estimateCost(usage, call)?.costMicrousd,
    onLeaseClosed: recordAgentRuntimeLease, auditRequired: true,
    ...(styleSkillRequested ? {
      prepareRequestRequired: true,
      prepareRequest: skillCall?.prepareRequest ?? (async () => null),
      authorizeDispatch: (lease) => {
        styleDispatchLease = lease;
        return skillHost?.authorizeDispatch(lease) === true && skillCall?.authorizeFixedRequest() === true;
      },
    } : {}),
  });
  const ticket = AGENT_ADMISSION_BROKER.issue({
    runId: input.runId, parentRunId: input.runId, sessionId: input.ticketSessionId,
    sourceRevision: input.sourceRevision, lane: 'learning', taskKind: 'style_compile',
    policyVersion: 'p14-q7-style-compiler-v1', modelId: provider.model,
    budgetProfileDigest: agentBudgetProfileDigest(budgetProfile), toolSetDigest: agentToolSetDigest(tools),
    mode: input.contentMode,
    reasonCodes: [input.explicitRequest ? 'explicit-style-save' : 'style-evidence-threshold'],
    evidenceDigests: [input.sourceDigest], noveltyDigest: input.sourceDigest, expectedBenefit: 'style-learning',
    limits: admissionLimitsFromBudgetProfile(budgetProfile), deadlineMs: Date.now() + budgetProfile.maxWallMs,
    allowedTools: [STYLE_DRAFT_TOOL_NAME], fullSkillSnapshots: [],
    cooldownKey: `style:${input.ticketSessionId}:${input.profileVersion}`,
    idempotencyKey: `admit:${input.runId}:style:${input.sourceDigest.slice(-16)}`, fallback: 'skip-optional-agent',
  });
  const lease = gateway.open({
    binding: {
      ticketId: ticket.ticketId, runId: ticket.runId, parentRunId: ticket.parentRunId,
      sessionId: ticket.sessionId, sourceRevision: ticket.sourceRevision, lane: ticket.lane,
      taskKind: ticket.taskKind, policyVersion: ticket.policyVersion, mode: ticket.mode, budgetProfile,
    },
    modelId: provider.model, tools,
  });
  let response: import('../../packages/proxy/public/client.ts').ChatResponse;
  let skillProof: ReturnType<ReturnType<typeof createStyleCompileSkillLiveCall>['sealOutput']> = null;
  try {
    response = await lease.complete(fixedRequest, input.signal);
    try { skillProof = skillCall?.sealOutput(response) ?? null; }
    catch { /* Optional provenance cannot change the original parsed draft or create another request. */ }
  } finally { skillCall?.abandon(); }
  // Provider work already happened: reject (consume the old attempt), never report a no-call skip.
  const fenced = () => Object.freeze({
    status: 'rejected' as const, reasonCode: 'style-proposal-store-rejected' as const,
  });
  if (styleSkillRequested && !skillProof) return fenced();
  if (!stillAuthorized()) return fenced();
  const parsed = parseLearnedStyleModelResponse(response);
  if (!parsed.ok) {
    console.warn('[StyleCompile] ' + parsed.reasonCode);
    return Object.freeze({ status: 'rejected', reasonCode: parsed.reasonCode });
  }
  const draft = parsed.draft;
  let evaluation: ReturnType<typeof evaluateLearnedStyleDraft>;
  try {
    evaluation = evaluateLearnedStyleDraft({ draft, samples: input.samples,
      forbiddenIdentityTerms: input.forbiddenIdentityTerms });
  } catch { return fenced(); }
  let committed: StyleProposalOutcome | undefined;
  let commitStarted = false;
  return Object.freeze({ status: 'prepared', commit: (): StyleProposalOutcome => {
    if (committed) return committed;
    if (commitStarted) return fenced();
    commitStarted = true;
    // No await between this authority read and business write; job CAS can wrap this commit later.
    if (!stillAuthorized()) return (committed = fenced());
    try {
      const proposal = LEARNED_STYLE_PROPOSALS.create({
        draft, sourceDigest: input.sourceDigest, profileVersion: input.profileVersion, model: provider.model,
        policyVersion: 'p14-q7-style-compiler-v1', evaluation, scope: input.scope,
      });
      if (skillProof && styleSkillSource) {
        try {
          commitStyleCompileSkillSourceReceipt({ rawSessionId, session: authority.session, source: styleSkillSource,
            proof: skillProof, proposalId: proposal.id, readProposal: (id) => LEARNED_STYLE_PROPOSALS.read(id),
            isCurrentSession: () => sessionDeletionAdmissionOpen(rawSessionId) && sessions.get(rawSessionId) === authority.session });
        } catch { console.warn('[StyleCompile] style-skill-source-write-failed'); }
      }
      // disabled -> validated only. Activation/readback are separate operator observations.
      try {
        const lineage = proposal.versions[0];
        // Closure lineage is permanently v1. An idempotent create() may find this source
        // at v2+, but that does not prove the original v1 run/sourceRevision for backfill.
        if (lineage?.sourceDigest === input.sourceDigest && lineage.profileVersion === input.profileVersion
          && lineage.model === provider.model && lineage.policyVersion === 'p14-q7-style-compiler-v1') {
          AGENT_CLOSURE_RECORDER?.beginStyleCompile({
            proposalId: proposal.id, sessionId: rawSessionId, sourceRevision: input.sourceRevision,
            sourceDigest: lineage.sourceDigest, profileVersion: input.profileVersion,
            policyVersion: 'p14-q7-style-compiler-v1', sessionKind: agentSessionKind(rawSessionId),
          });
        }
      } catch {
        // A sidecar failure cannot turn an already-created proposal into a no-effect failure.
        // No validation evidence is fabricated; durable recovery must read back the real Store.
        console.warn('[StyleCompile] style-proposal-closure-write-failed');
      }
      return (committed = Object.freeze({ status: 'created', proposalId: proposal.id }));
    } catch {
      console.warn('[StyleCompile] style-proposal-store-rejected');
      return (committed = fenced());
    }
  } });
}

/** Real business composition; lifecycle/cutover remains explicit and is not started here. */
function createServerStyleCompilePipeline(store: StyleCompileJobStore) {
  return createStyleCompilePipeline({ store, now: () => new Date().toISOString(),
    resolveSession: (id) => sessions.get(id) ?? null,
    isSessionDeleted: (id) => !sessionDeletionAdmissionOpen(id),
    prepare: (id, input, job) => prepareStyleProposalForSession(id, input, job ? { store, job } : undefined),
    readProposal: (id) => LEARNED_STYLE_PROPOSALS.read(id),
  });
}

/** A restart selects delivery; live revocation may close it, never rebind an in-flight turn. */
function styleCompileBackgroundAllowed(): boolean {
  try {
    const live = parseStyleCompileRuntimeConfig(process.env);
    return STYLE_COMPILE_RUNTIME_CONFIG.enabled && styleCompileStartupReady && !shuttingDown && releaseAdmissionOpen()
      && live.enabled && live.pilot?.policyDigest === STYLE_COMPILE_RUNTIME_CONFIG.pilot?.policyDigest;
  } catch { return false; }
}

/** Open historical metadata even after rollback to sync; that mode never claims model work. */
function createServerStyleCompileRuntime(): StyleCompileRuntime | null {
  const dataDir = resolve(DATA_DIR, STYLE_COMPILE_JOB_DATA_DIRECTORY);
  if (!STYLE_COMPILE_RUNTIME_CONFIG.enabled && !existsSync(resolve(dataDir, STYLE_COMPILE_JOB_DB_FILE))) return null;
  const store = new StyleCompileJobStore({ dataDir, now: () => new Date().toISOString() });
  try {
    return startStyleCompileRuntime({ store, pipeline: createServerStyleCompilePipeline(store),
      listSessionIds: (input) => scanStyleCompileRecoverySessions({ dataDir: DATA_DIR, ...input,
        resolveDatabase: (file) => resolveSessionDatabase(DATA_DIR, file), allowed: sessionDeletionAdmissionOpen }),
      loadSession: loadSessionById, sourceAllowed: sessionDeletionAdmissionOpen,
      isPrivacyCommitted: (id) => SESSION_DELETION_JOURNAL.isPrivacyCommitted(id),
      isSessionAvailable: (id) => !sessions.get(id)?.isBusy() && turnJobs.getActiveForSession(id) === null
        && maintenanceHarness?.isPostTurnBackgroundReady(id) === true,
      mode: () => styleCompileBackgroundAllowed() ? 'background' : 'off',
      ownerId: `style.${SERVER_INSTANCE_ID}`, now: () => new Date().toISOString(),
      intervalMs: STYLE_COMPILE_RUNTIME_CONFIG.intervalMs, leaseMs: STYLE_COMPILE_RUNTIME_CONFIG.leaseMs,
      sessionLimit: STYLE_COMPILE_RUNTIME_CONFIG.sessionPageSize, intentPageSize: STYLE_COMPILE_RUNTIME_CONFIG.intentPageSize,
      jobLimit: STYLE_COMPILE_RUNTIME_CONFIG.jobsPerTick, runOnStart: false,
      timers: {
        setInterval: (callback, ms) => { const timer = setInterval(callback, ms); timer.unref(); return timer; },
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      }, logger: (code) => console.warn(code),
    });
  } catch (error) { store.close(); throw error; }
}

/** Mutually exclusive delivery captured for both newly created and restored Sessions. */
function styleCompileAdmissionForSession(rawSessionId: string) {
  return {
    ...(STYLE_COMPILE_RUNTIME_CONFIG.enabled ? {
      styleCompileDelivery: 'outbox' as const,
      observeStyleCompileIntent: (input: { rawSessionId: string; runId: string; packetDigest: string }) => {
        if (input.rawSessionId === rawSessionId) STYLE_COMPILE_RUNTIME?.wakeSession(rawSessionId);
      },
    } : {}),
    captureStyleCompileBinding: (input: { rawSessionId: string; contentMode: 'nsf' | 'nsfw' }) =>
      input.rawSessionId === rawSessionId ? captureStyleCompileBindingForSession(rawSessionId, input.contentMode) : null,
    requestStyleProposal: async (input: StyleProposalInput) => {
      const prepared = await prepareStyleProposalForSession(rawSessionId, input);
      return prepared.status === 'prepared' ? prepared.commit() : prepared;
    },
  };
}

function learnedStyleAdoptionForSession(rawSessionId: string): NonNullable<SessionArgs['commitLearnedStyleAdoption']> {
  return (consumption) => {
    const session = sessions.get(rawSessionId);
    if (!session || consumption.rawSessionId !== rawSessionId || !sessionDeletionAdmissionOpen(rawSessionId)) {
      throw new Error('style-compile-adoption-session-unavailable');
    }
    commitStyleCompileSkillAdoption({ rawSessionId, session, consumption,
      readProposal: (id) => LEARNED_STYLE_PROPOSALS.read(id),
      isCurrentSession: () => sessions.get(rawSessionId) === session && sessionDeletionAdmissionOpen(rawSessionId),
    });
  };
}

function foregroundSkillHostForSession(
  rawSessionId: string,
  session: ChatSession,
  readEligibility: Parameters<typeof createForegroundSkillHostAuthority>[0]['readEligibility'],
  liveEnabled: () => boolean = () => agentSkillLiveEnabled(process.env),
) {
  return createForegroundSkillHostAuthority({ turnAuthority: session, controlStore: AGENT_CONTROL_STORE,
    readLaneRuntime: () => parseAgentLaneRuntimeConfig(process.env), readEligibility, liveEnabled,
    isCurrentSession: () => sessionDeletionAdmissionOpen(rawSessionId) && sessions.get(rawSessionId) === session,
    safetyAuthority: { readForLease: (lease, turn) => {
      const dbPath = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!dbPath) return null;
      return { sessionId: lease.sessionId, sourceRevision: turn.sourceRevision,
        state: NSFW_SCENE_SAFETY_CONTROL.read({ dbPath, sessionId: rawSessionId,
          manifest: session.getWorldbookSourceManifest() }) };
    } },
  });
}

function variableProposalSkillForSession(rawSessionId: string): SessionArgs['variableProposalSkill'] {
  return async (input) => {
    if (!variableProposalSkillLiveEnabled(process.env)) return null;
    if (!AGENT_CLOSURE_STORE || !AGENT_ADMISSION_LEDGER || !MODEL_USAGE_COST
      || input.rawSessionId !== rawSessionId || input.signal.aborted) {
      throw new Error('variable-proposal-skill-unavailable');
    }
    const session = sessions.get(rawSessionId);
    if (!session || !sessionDeletionAdmissionOpen(rawSessionId)) {
      throw new Error('variable-proposal-skill-session-unavailable');
    }
    const current = () => {
      const turn = session.readAgentSkillTurnContext(input.runId);
      return variableProposalSkillLiveEnabled(process.env) && !input.signal.aborted
        && sessionDeletionAdmissionOpen(rawSessionId) && sessions.get(rawSessionId) === session
        && turn?.sessionId === opaqueLearningToken('session', rawSessionId)
        && turn.sourceRevision === input.source.sourceRevision && turn.contentMode === input.contentMode
        && input.source.runId === input.runId && input.source.round === input.round
        && input.source.contentMode === input.contentMode && session.getHistoryEpoch() === input.source.historyEpoch;
    };
    const live = parseAgentAdmissionRuntimeConfig(process.env);
    if (!current() || !agentAdmissionAllowsSession(live, rawSessionId)) {
      throw new Error('variable-proposal-skill-admission-denied');
    }
    const { selection: provider, client } = agentModelBinding();
    const readBudget = () => {
      const base = agentTaskBudgetProfile('interactive_prelude', process.env,
        { maxOutputTokens: input.source.maxOutputTokens }, modelRuntimeProfileFor(provider, client));
      return normalizeAgentBudgetProfile({ ...base, maxSteps: 1, maxModelCalls: 1, maxToolCalls: 0, maxWrites: 0,
        agentInputBudgetTokens: Math.min(4_000, base.agentInputBudgetTokens), maxToolResultChars: 0 });
    };
    const budgetProfile = readBudget();
    const request = buildVariableProposalSkillRequest({ source: input.source, specs: input.specs,
      values: input.values, userInput: input.userInput, model: provider.model });
    const host = foregroundSkillHostForSession(rawSessionId, session, (lease) => {
      const budget = readBudget();
      return { revision: agentBudgetProfileDigest(budget), allowed: current()
        && agentAdmissionAllowsSession(parseAgentAdmissionRuntimeConfig(process.env), rawSessionId)
        && agentBudgetProfileDigest(budget) === lease.budgetProfileDigest };
    }, () => variableProposalSkillLiveEnabled(process.env));
    const skillCall = createVariableProposalSkillLiveCall({ broker: AGENT_ADMISSION_BROKER,
      rawSessionId, source: input.source, specs: input.specs, values: input.values, userInput: input.userInput,
      request, authority: host.authority });
    let physicalLease: AgentAdmissionLease | undefined;
    let closedAudit: AdmittedModelLeaseAudit | undefined;
    let auditRecorded = false;
    const recordClosedAudit = () => {
      if (!closedAudit || auditRecorded) return false;
      auditRecorded = true;
      recordAgentRuntimeLease(closedAudit);
      return true;
    };
    const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER,
      turnOperationClientForServer(rawSessionId, input.runId, 'prelude', arbitratedAgentClient(client, provider, 'interactive-prelude', undefined, () => {
        if (!physicalLease || !AGENT_ADMISSION_BROKER.mayDispatchLease(physicalLease)
          || !current() || !host.authorizeDispatch(physicalLease)
          || !skillCall.authorizeFixedRequest() || !skillCall.authorizeCurrentContext(physicalLease)) {
          throw new AdmittedModelGatewayError('gateway-dispatch-authority-denied');
        }
      })), {
        estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
        onLeaseClosed: (audit) => { closedAudit = audit; }, auditRequired: true, prepareRequestRequired: true,
        prepareRequest: skillCall.prepareRequest,
        authorizeDispatch: (lease) => { physicalLease = lease; return current() && host.authorizeDispatch(lease); },
      });
    const ticket = AGENT_ADMISSION_BROKER.issue({
      runId: input.runId, parentRunId: input.runId, sessionId: opaqueLearningToken('session', rawSessionId),
      sourceRevision: input.source.sourceRevision, lane: 'interactive', taskKind: 'interactive_prelude',
      policyVersion: input.source.policyVersion, modelId: provider.model,
      budgetProfileDigest: agentBudgetProfileDigest(budgetProfile), toolSetDigest: agentToolSetDigest([]),
      mode: input.contentMode, reasonCodes: ['variable-proposal-staged'], evidenceDigests: [input.source.sourceDigest],
      noveltyDigest: input.source.sourceDigest, expectedBenefit: 'state-correctness',
      limits: admissionLimitsFromBudgetProfile(budgetProfile), deadlineMs: Date.now() + budgetProfile.maxWallMs,
      allowedTools: [], fullSkillSnapshots: [], cooldownKey: `variable-proposal:${input.runId}`,
      idempotencyKey: `admit:${input.runId}:variable-proposal`, fallback: 'skip-optional-agent',
    });
    try {
      const response = await gateway.complete({ binding: { ticketId: ticket.ticketId, runId: ticket.runId,
        parentRunId: ticket.parentRunId, sessionId: ticket.sessionId, sourceRevision: ticket.sourceRevision,
        lane: ticket.lane, taskKind: ticket.taskKind, policyVersion: ticket.policyVersion, mode: ticket.mode,
        budgetProfile }, request, signal: input.signal });
      const candidate = typeof response.content === 'string'
        ? parseVariableProposalSkillOutput(response.content, input.specs, input.source.maxCandidateCount) : null;
      if (!candidate) throw new Error('variable-proposal-skill-output-invalid');
      if (!current() || !physicalLease
        || !skillCall.sealOutput(response.content, candidate.candidateDigest)) {
        throw new Error('variable-proposal-skill-authority-denied');
      }
      const lease = physicalLease;
      const permissionSnapshot = () => {
        const turn = session.readAgentSkillTurnContext(input.runId);
        if (!turn || !host.authorizeDispatch(lease)) return null;
        const lane = AGENT_CONTROL_STORE.get('interactive');
        const capabilities = ['interactive.prelude', 'interactive.director', 'interactive.variableProposal'] as const;
        const controls = capabilities.map((id) => AGENT_CONTROL_STORE.capabilityControl(id));
        if (lane.desiredState === 'off' || lane.desiredState === 'killed' || lane.killedReason !== null
          || controls.some((control) => control.killedReason !== null)) return null;
        const safety = input.contentMode === 'nsfw' ? host.authority.safetyAuthority.readForLease(lease, turn) : null;
        if (input.contentMode === 'nsfw' && (!safety || !safety.state.enabled
          || safety.state.reasonCode !== 'active' || safety.state.adultAttestation !== 'verified'
          || !safety.state.participantsAdult || safety.state.consent !== 'confirmed'
          || !Number.isSafeInteger(safety.state.revision) || safety.state.revision < 1
          || safety.state.sourceRevision !== turn.worldbookSourceRevision)) return null;
        // Pin runtime policy independently of this successful call's own quota accounting.
        const laneRuntime = parseAgentLaneRuntimeConfig(process.env);
        return JSON.stringify({ lane, controls, safety, laneRuntime });
      };
      const permission = permissionSnapshot();
      if (!permission || !recordClosedAudit() || !current() || permissionSnapshot() !== permission) {
        throw new Error('variable-proposal-skill-authority-denied');
      }
      return { request, content: response.content, seal: ({ candidateDigest }) => current()
        && candidateDigest === candidate.candidateDigest && permissionSnapshot() === permission };
    } catch (error) {
      skillCall.abandon();
      throw error;
    } finally {
      if (!auditRecorded && closedAudit) recordClosedAudit();
    }
  };
}

/** Read accepted lineage, not the moving interactive revision; changed representatives fail closed. */
function styleProposalSourceAuthority(rawSessionId: string, input: StyleProposalInput):
  Readonly<{ session: ChatSession; sourceDigest: string }> | null {
  try {
    const session = sessions.get(rawSessionId);
    if (!session || !sessionDeletionAdmissionOpen(rawSessionId) || input.rawSessionId !== rawSessionId
      || input.runId === 'missing-run' || input.ticketSessionId !== opaqueLearningToken('session', rawSessionId)
      || !agentCapabilityTicketAllowed(AGENT_CONTROL_STORE, {
        taskKind: 'style_compile', policyVersion: 'p14-q7-style-compiler-v1' })) return null;
    // Source rechecks are pure reads. Ticket admission owns any persistent rollout kill transition.
    const laneRuntime = parseAgentLaneRuntimeConfig(process.env);
    const laneControl = AGENT_CONTROL_STORE.get('learning');
    if (laneControl.desiredState === 'killed') return null;
    const laneDecision = evaluateAgentLaneRollout({
      lane: 'learning',
      sessionId: laneRuntime.managed
        ? agentLaneRolloutBucketIdentity(laneRuntime, input.ticketSessionId) : input.ticketSessionId,
      desiredState: laneRuntime.managed ? laneControl.desiredState : 'on',
      hostCeiling: laneRuntime.managed ? laneRuntime.ceilings.learning : 'on',
      evidence: AGENT_CONTROL_STORE.evidence('learning'),
    });
    if (laneDecision.shouldKill || (laneRuntime.managed && !laneDecision.allowed)) return null;
    const scope = session.learnedStyleProposalScope(input.contentMode);
    if (Object.keys(input.scope).sort().join(',') !== 'baseStyleSkillId,cardId,contentMode,sessionId'
      || scope.sessionId !== input.ticketSessionId || input.scope.sessionId !== scope.sessionId
      || input.scope.cardId !== scope.cardId || input.scope.contentMode !== scope.contentMode
      || input.scope.baseStyleSkillId !== scope.baseStyleSkillId) return null;
    const retainedIntent = session.readStyleCompileIntent(input.runId);
    // Once a durable intent exists, deleting optional fields must never downgrade it to the legacy path.
    if (retainedIntent || input.intentPacketDigest !== undefined) {
      if (!retainedIntent || !input.intentPacketDigest || !input.originalBinding
        || retainedIntent.packetDigest !== input.intentPacketDigest
        || !/^sha256:[a-f0-9]{64}$/u.test(input.intentPacketDigest)) return null;
      const original = session.styleCompileIntentRequest(input.runId, input.intentPacketDigest);
      if (!original) return null;
      const metadata = (value: StyleProposalInput) => ({ rawSessionId: value.rawSessionId,
        ticketSessionId: value.ticketSessionId, runId: value.runId, sourceRevision: value.sourceRevision,
        contentMode: value.contentMode, sourceDigest: value.sourceDigest, profileVersion: value.profileVersion,
        explicitRequest: value.explicitRequest, scope: value.scope, originalBinding: value.originalBinding,
        intentPacketDigest: value.intentPacketDigest,
        samples: value.samples.map((sample) => ({ sourceRevision: sample.sourceRevision, proseDigest: sha256Digest(sample.prose) })),
        forbiddenIdentityDigest: sha256Digest(JSON.stringify(value.forbiddenIdentityTerms)),
      });
      if (JSON.stringify(metadata(original)) !== JSON.stringify(metadata(input))) return null;
      return Object.freeze({ session, sourceDigest: sha256Digest(JSON.stringify({
        version: 'style-intent-source-authority-v1', packetDigest: input.intentPacketDigest, source: metadata(original),
      })) });
    }
    const marker = session.turnOutcome(input.runId);
    if (!marker || marker.runId !== input.runId || marker.sessionId !== rawSessionId
      || marker.action !== 'turn' || marker.revision !== input.sourceRevision
      || marker.revision !== `round-${marker.round}-assistant-${marker.assistantMessageId}`) return null;
    const epoch = session.getHistoryEpoch();
    const profile = /^style-profile-v1-(0|[1-9]\d*)$/u.exec(input.profileVersion);
    const acceptedSamples = profile ? Number(profile[1]) : NaN;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(acceptedSamples)
      || !/^sha256:[a-f0-9]{64}$/u.test(input.sourceDigest)) return null;
    const db = session.getMemory().mem.db;
    type EvidenceRow = {
      event_id: string; run_id: string | null; round: number; assistant_message_id: number | null;
      source_revision: string; subject_digest: string; features_json: string; payload_digest: string;
    };
    const anchors = db.prepare(`SELECT * FROM learning_outbox WHERE event_kind='turn_accepted_weak'
      AND run_id=? AND session_id=? AND card_id=? AND content_mode=? AND source_revision=?
      AND round=? AND assistant_message_id=? LIMIT 2`).all(opaqueLearningToken('run', input.runId),
      scope.sessionId, scope.cardId, input.contentMode, input.sourceRevision,
      marker.round, marker.assistantMessageId) as EvidenceRow[];
    if (anchors.length !== 1) return null;
    const anchor = anchors[0]!;
    const anchorFeatures = JSON.parse(anchor.features_json) as Record<string, unknown>;
    const styleSkillId = anchorFeatures.styleSkillId;
    if (anchorFeatures.styleEvidenceVersion !== 'style-evidence-v1' || anchorFeatures.styleAcceptance !== 'weak'
      || typeof styleSkillId !== 'string' || !/^style:sha256:[a-f0-9]{64}$/u.test(styleSkillId)) return null;
    // Tombstones invalidate lineage across mode switches, but never across session ownership.
    const tombstoned = db.prepare(`SELECT 1 FROM learning_outbox WHERE session_id=? AND
      ((event_kind='delete' AND source_revision=?) OR (event_kind='regenerate'
        AND json_extract(features_json,'$.replacedSourceRevision')=?)) LIMIT 1`);
    if (tombstoned.get(scope.sessionId, input.sourceRevision, input.sourceRevision)) return null;
    const accepted = db.prepare(`SELECT sample.* FROM learning_outbox sample
      WHERE sample.event_kind='turn_accepted_weak' AND sample.session_id=? AND sample.card_id=?
        AND sample.content_mode=? AND sample.source_revision IS NOT NULL
        AND json_extract(sample.features_json,'$.styleAcceptance')='weak'
        AND json_extract(sample.features_json,'$.styleSkillId')=?
        AND json_type(sample.features_json,'$.proseDigest')='text'
        AND NOT EXISTS (SELECT 1 FROM learning_outbox tombstone WHERE tombstone.session_id=sample.session_id
          AND ((tombstone.event_kind='delete' AND tombstone.source_revision=sample.source_revision)
            OR (tombstone.event_kind='regenerate'
              AND json_extract(tombstone.features_json,'$.replacedSourceRevision')=sample.source_revision)))
      ORDER BY sample.round DESC,sample.event_id DESC LIMIT 8`).all(
      scope.sessionId, scope.cardId, input.contentMode, styleSkillId) as EvidenceRow[];
    if (accepted.length < 1 || input.samples.length !== accepted.length) return null;
    const evidence: Array<{ eventId: string; payloadDigest: string; proseDigest: string }> = [];
    for (const [index, row] of accepted.entries()) {
      const features = JSON.parse(row.features_json) as Record<string, unknown>;
      const message = row.assistant_message_id === null ? undefined : db.prepare(
        "SELECT content FROM chat_log WHERE id=? AND round=? AND role='assistant' LIMIT 1",
      ).get(row.assistant_message_id, row.round) as { content: string } | undefined;
      if (!message || features.styleEvidenceVersion !== 'style-evidence-v1'
        || typeof features.proseDigest !== 'string' || sha256Digest(message.content) !== features.proseDigest
        || !/^sha256:[a-f0-9]{64}$/u.test(row.payload_digest)
        || input.samples[index]!.sourceRevision !== row.source_revision
        || input.samples[index]!.prose !== message.content) return null;
      evidence.push({ eventId: row.event_id, payloadDigest: row.payload_digest, proseDigest: features.proseDigest });
    }
    // The source itself may no longer be among the latest eight representatives.
    const anchorMessage = db.prepare("SELECT content FROM chat_log WHERE id=? AND round=? AND role='assistant'")
      .get(marker.assistantMessageId, marker.round) as { content: string } | undefined;
    if (!anchorMessage || sha256Digest(anchorMessage.content) !== anchorFeatures.proseDigest
      || !/^sha256:[a-f0-9]{64}$/u.test(anchor.payload_digest)) return null;
    const legacySourceDigest = sha256Digest(JSON.stringify({ acceptedSamples,
      representatives: accepted.map((row) => ({ revision: row.source_revision, subject: row.subject_digest }))
        .sort((left, right) => left.revision.localeCompare(right.revision)),
    }));
    if (legacySourceDigest !== input.sourceDigest) return null;
    const baselines = ['style-proposal-count', 'style-proposal-attempt-count'].map((key) => {
      const row = db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
        .get(rawSessionId, `${key}:${input.contentMode}`) as { value: string } | undefined;
      if (row && (!/^(0|[1-9]\d*)$/u.test(row.value) || !Number.isSafeInteger(Number(row.value)))) {
        throw new Error('style-source-baseline-invalid');
      }
      return row?.value ?? null;
    });
    return Object.freeze({ session, sourceDigest: sha256Digest(JSON.stringify({
      version: 'style-source-authority-v1', scope, epoch, marker, styleSkillId,
      anchor: { eventId: anchor.event_id, payloadDigest: anchor.payload_digest,
        proseDigest: anchorFeatures.proseDigest },
      profileVersion: input.profileVersion, sourceDigest: input.sourceDigest, evidence, baselines,
      explicitRequest: input.explicitRequest,
      forbiddenIdentityDigest: sha256Digest(JSON.stringify(input.forbiddenIdentityTerms)),
    })) });
  } catch { return null; }
}

function agentAdmissionForSession(rawSessionId: string): import('../../packages/session/src/session.ts').SessionArgs['agentAdmission'] {
  if ((!AGENT_ADMISSION_RUNTIME.enabled && !CONTEXT_COMPILER_RUNTIME.enabled)
    || !AGENT_ADMISSION_LEDGER) return undefined;
  let pendingPreferenceProof: ReturnType<ReturnType<typeof createLearningPreferenceSkillLiveCall>['sealOutput']> = null;
  let pendingBranchProof: ReturnType<ReturnType<typeof createBranchPreferenceSkillLiveCall>['sealOutput']> = null;
  let branchCommitHost: Readonly<{
    session: ChatSession; authority: ReturnType<typeof createBranchPreferenceSkillSourceCommitAuthority>;
  }> | null = null;
  const branchCommitAuthority = () => {
    const session = sessions.get(rawSessionId);
    if (!session || !sessionDeletionAdmissionOpen(rawSessionId)) return null;
    if (branchCommitHost?.session === session) return branchCommitHost.authority;
    const authority = createBranchPreferenceSkillSourceCommitAuthority({ rawSessionId, session,
      isCurrentSession: () => sessionDeletionAdmissionOpen(rawSessionId) && sessions.get(rawSessionId) === session });
    branchCommitHost = Object.freeze({ session, authority });
    return authority;
  };
  let preferenceCommitHost: Readonly<{
    session: ChatSession; authority: ReturnType<typeof createLearningPreferenceSkillSourceCommitAuthority>;
  }> | null = null;
  const preferenceCommitAuthority = () => {
    const session = sessions.get(rawSessionId);
    if (!session || !sessionDeletionAdmissionOpen(rawSessionId)) return null;
    if (preferenceCommitHost?.session === session) return preferenceCommitHost.authority;
    const authority = createLearningPreferenceSkillSourceCommitAuthority({ rawSessionId, session,
      isCurrentSession: () => sessionDeletionAdmissionOpen(rawSessionId) && sessions.get(rawSessionId) === session });
    preferenceCommitHost = Object.freeze({ session, authority });
    return authority;
  };
  let pendingCriticSkill: ReturnType<typeof createCriticSkillLiveCall> | null = null;
  let pendingPreludeSkill: ReturnType<typeof createPreludeSkillLiveCall> | null = null;
  let pendingCriticSkillCurrent: (() => boolean) | null = null;
  let pendingPreludeSkillCurrent: (() => boolean) | null = null;
  let memoryConsumptionHost: { session: ChatSession; authority: MaintenanceMemoryConsumptionAuthority } | null = null;
  let summaryConsumptionHost: { session: ChatSession; authority: MaintenanceSummaryConsumptionAuthority } | null = null;
  const consumptionAllowed = (session: ChatSession, mode: 'nsf' | 'nsfw', consumerRunId: string,
    taskKind: 'memory_consolidation' | 'rolling_summary'): boolean => {
    const live = taskKind === 'rolling_summary'
      ? maintenanceSummarySkillLiveEnabled(process.env) : maintenanceMemorySkillLiveEnabled(process.env);
    if (!live || sessions.get(rawSessionId) !== session || !sessionDeletionAdmissionOpen(rawSessionId)
      || !maintenanceJobs.settings(rawSessionId).effectiveEnabled
      || !maintenanceAdmissionAllowsSession(MAINTENANCE_ADMISSION_RUNTIME, rawSessionId)) return false;
    // Adoption only observes current permission; decide()/execution gates may write a kill.
    const runtime = parseAgentLaneRuntimeConfig(process.env);
    const control = AGENT_CONTROL_STORE.get('maintenance');
    const decision = evaluateAgentLaneRollout({
      lane: 'maintenance', desiredState: runtime.managed ? control.desiredState : 'on',
      sessionId: runtime.managed ? agentLaneRolloutBucketIdentity(runtime, rawSessionId) : rawSessionId,
      hostCeiling: runtime.managed ? runtime.ceilings.maintenance : 'on',
      evidence: AGENT_CONTROL_STORE.evidence('maintenance'),
    });
    if (control.desiredState === 'killed' || decision.shouldKill || (runtime.managed && !decision.allowed)
      || !agentCapabilityTicketAllowed(AGENT_CONTROL_STORE, { taskKind, policyVersion: MAINTENANCE_POLICY_VERSION })) {
      return false;
    }
    const turn = session.readAgentSkillTurnContext(consumerRunId);
    if (!turn || turn.contentMode !== mode) return false;
    if (mode === 'nsf') return true;
    const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
    if (!path) return false;
    const safety = NSFW_SCENE_SAFETY_CONTROL.read({ dbPath: path, sessionId: rawSessionId,
      manifest: session.getWorldbookSourceManifest() });
    return safety.enabled && safety.adultAttestation === 'verified'
      && safety.participantsAdult && safety.consent === 'confirmed';
  };
  const memoryConsumptionAuthority = () => {
    const session = sessions.get(rawSessionId);
    if (!session || !AGENT_CLOSURE_STORE || !maintenanceMemorySkillLiveEnabled(process.env)) return null;
    if (memoryConsumptionHost?.session === session) return memoryConsumptionHost.authority;
    const committer = new MemorySummaryMaintenanceCommitter({
      sessionId: rawSessionId, memory: session.getMemory().mem,
    }, () => { throw new Error('memory-consumption-current-revision-forbidden'); });
    const authority = new MaintenanceMemoryConsumptionAuthority({
      sessionId: rawSessionId, manager: maintenanceJobs, committer,
      allowed: (mode, runId) => consumptionAllowed(session, mode, runId, 'memory_consolidation'),
    });
    memoryConsumptionHost = { session, authority };
    return authority;
  };
  const summaryConsumptionAuthority = () => {
    const session = sessions.get(rawSessionId);
    if (!session || !AGENT_CLOSURE_STORE || !maintenanceSummarySkillLiveEnabled(process.env)) return null;
    if (summaryConsumptionHost?.session === session) return summaryConsumptionHost.authority;
    const committer = new MemorySummaryMaintenanceCommitter({
      sessionId: rawSessionId, memory: session.getMemory().mem,
    }, () => { throw new Error('summary-consumption-current-revision-forbidden'); });
    const authority = new MaintenanceSummaryConsumptionAuthority({
      sessionId: rawSessionId, manager: maintenanceJobs, committer,
      allowed: (mode, runId) => consumptionAllowed(session, mode, runId, 'rolling_summary'),
    });
    summaryConsumptionHost = { session, authority };
    return authority;
  };
  const runPreferenceLearningCall = async (input: {
    client: ChatCompletionClient;
    rawSessionId: string;
    ticketSessionId: string;
    runId: string;
    sourceRevision: string;
    contentMode: 'nsf' | 'nsfw';
    userPrompt?: string;
    userInput?: string;
    branches?: readonly string[];
    candidates?: readonly import('../../packages/agent-policy/public/branch-preference.ts').SemanticBranchCandidate[];
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
    if (learningPreferenceSkillPolicyAllowed(request.policyVersion)) pendingPreferenceProof = null;
    if (branchPreferenceSkillPolicyAllowed(request.policyVersion)) pendingBranchProof = null;
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
    const { selection: provider, client: rawPreferenceClient } = agentModelBinding();
    // P17-01.3：偏好抽取是后台（learning），走全局仲裁；被前台抢占后结果作废。
    const client = turnOperationClientForServer(rawSessionId, input.runId, 'prelude',
      arbitratedAgentClient(rawPreferenceClient, provider, 'learning'));
    const budgetProfile = agentTaskBudgetProfile(
      'preference_extract',
      process.env,
      { maxOutputTokens: request.maxOutputTokens },
      modelRuntimeProfileFor(provider, client),
    );
    const tools: Record<string, unknown>[] = [];
    const evidenceDigest = sha256Digest(JSON.stringify(request.evidence));
    const modelRequest = {
      model: provider.model, ...request.modelRequest, max_tokens: budgetProfile.agentOutputBudgetTokens,
    };
    const skillEnabled = () => learningPreferenceSkillPolicyAllowed(request.policyVersion)
      ? learningPreferenceSkillLiveEnabled(process.env)
      : branchPreferenceSkillPolicyAllowed(request.policyVersion) && branchPreferenceSkillLiveEnabled(process.env);
    const skillRequested = Boolean(AGENT_CLOSURE_STORE && (
      (learningPreferenceSkillLiveEnabled(process.env) && learningPreferenceSkillPolicyAllowed(request.policyVersion))
      || (branchPreferenceSkillLiveEnabled(process.env) && branchPreferenceSkillPolicyAllowed(request.policyVersion))));
    const session = skillRequested ? sessions.get(rawSessionId) : undefined;
    const skillHost = session ? foregroundSkillHostForSession(rawSessionId, session, (lease) => {
      const current = parseAgentAdmissionRuntimeConfig(process.env);
      const privacy = parseLearningTextRuntimeConfig(process.env);
      const budget = agentTaskBudgetProfile('preference_extract', process.env,
        { maxOutputTokens: request.maxOutputTokens }, modelRuntimeProfileFor(provider, client));
      return { revision: agentBudgetProfileDigest(budget), allowed: privacy.preferenceEnabled
        && agentAdmissionAllowsSession(current, rawSessionId)
        && agentBudgetProfileDigest(budget) === lease.budgetProfileDigest };
    }, skillEnabled) : null;
    let skillCall: ReturnType<typeof createLearningPreferenceSkillLiveCall>
      | ReturnType<typeof createBranchPreferenceSkillLiveCall> | null = null;
    let authorizeSkillDispatch: ReturnType<typeof createLearningPreferenceSkillDispatchAuthority> | null = null;
    if (session && skillHost && learningPreferenceSkillPolicyAllowed(request.policyVersion)
      && typeof input.userPrompt === 'string') {
      try {
        const source = captureLearningPreferenceSkillSource({ runId: input.runId, sourceAuthority: session });
        const isSessionOpen = () => sessionDeletionAdmissionOpen(rawSessionId)
          && sessions.get(rawSessionId) === session;
        const skillSourceAuthority = createLearningPreferenceSkillSourceAuthority({
          source, sourceAuthority: session, isSessionOpen, leaseAuthority: AGENT_ADMISSION_BROKER,
        });
        const safetyAuthority = { readForLease: (lease: import('./agent-admission-broker.ts').AgentAdmissionLease,
          current: import('./skill-hub/context-authority.ts').ServerAgentSkillContextSourceV1) => {
          const turn = session.readAgentSkillTurnContext(lease.parentRunId);
          return turn && turn.sourceRevision === current.sourceRevision
            ? skillHost.authority.safetyAuthority.readForLease(lease, turn) : null;
        } };
        authorizeSkillDispatch = createLearningPreferenceSkillDispatchAuthority({
          sourceAuthority: skillSourceAuthority, authorizeHost: skillHost.authorizeDispatch, safetyAuthority,
        });
        skillCall = createLearningPreferenceSkillLiveCall({
          broker: AGENT_ADMISSION_BROKER, source, userPrompt: input.userPrompt, request: modelRequest,
          authority: { ...skillHost.authority, sourceAuthority: session, isSessionOpen, safetyAuthority },
        });
      } catch {
        // Invalid fixed inputs are not a Skill-readiness fallback. The registered source must still match.
        authorizeSkillDispatch = null;
      }
    }
    if (session && skillHost && branchPreferenceSkillPolicyAllowed(request.policyVersion)
      && typeof input.userInput === 'string' && input.branches && input.candidates) {
      try {
        const source = captureBranchPreferenceSkillSource({ runId: input.runId, sourceAuthority: session });
        const isSessionOpen = () => sessionDeletionAdmissionOpen(rawSessionId)
          && sessions.get(rawSessionId) === session;
        const skillSourceAuthority = createBranchPreferenceSkillSourceAuthority({
          source, sourceAuthority: session, isSessionOpen, leaseAuthority: AGENT_ADMISSION_BROKER,
        });
        const safetyAuthority = { readForLease: (lease: import('./agent-admission-broker.ts').AgentAdmissionLease,
          current: import('./skill-hub/context-authority.ts').ServerAgentSkillContextSourceV1) => {
          const turn = session.readAgentSkillTurnContext(lease.parentRunId);
          return turn && turn.sourceRevision === current.sourceRevision
            ? skillHost.authority.safetyAuthority.readForLease(lease, turn) : null;
        } };
        authorizeSkillDispatch = createBranchPreferenceSkillDispatchAuthority({
          sourceAuthority: skillSourceAuthority, authorizeHost: skillHost.authorizeDispatch, safetyAuthority,
        });
        skillCall = createBranchPreferenceSkillLiveCall({
          broker: AGENT_ADMISSION_BROKER, source, editedInput: input.userInput,
          branches: input.branches, candidates: input.candidates, request: modelRequest,
          authority: { ...skillHost.authority, sourceAuthority: session, isSessionOpen, safetyAuthority },
        });
      } catch { authorizeSkillDispatch = null; }
    }
    const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, client, {
      estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
      onLeaseClosed: recordAgentRuntimeLease,
      auditRequired: true,
      ...(skillRequested ? {
        prepareRequest: skillCall?.prepareRequest ?? (async () => null),
        authorizeDispatch: (lease) => authorizeSkillDispatch?.(lease) === true
          && (skillCall?.authorizeFixedRequest() ?? true),
      } : {}),
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
    try {
      const response = await lease.complete(modelRequest, input.signal);
      lease.finish('completed');
      try {
        const proof = skillCall?.sealOutput(response.content);
        if (proof?.version === 'learning-preference-skill-proof-v1') pendingPreferenceProof = proof;
        else if (proof?.version === 'branch-preference-skill-proof-v1') pendingBranchProof = proof;
      }
      catch { /* Output provenance is optional and cannot discard a valid classifier response. */ }
      return response.content;
    } finally {
      skillCall?.abandon();
    }
  };
  return {
    preparePreferenceSkillSource: (input) => {
      const proof = pendingPreferenceProof;
      pendingPreferenceProof = null;
      return preferenceCommitAuthority()?.prepare(proof, input) ?? null;
    },
    commitPreferenceSkillSource: (input) => preferenceCommitAuthority()?.commit(input) ?? null,
    prepareBranchPreferenceSkillSource: (input) => {
      const proof = pendingBranchProof;
      pendingBranchProof = null;
      return branchCommitAuthority()?.prepare(proof, input) ?? null;
    },
    commitBranchPreferenceSkillSource: (input) => branchCommitAuthority()?.commit(input) ?? null,
    observeBranchPreferenceSkillSource: () => {
      try { scheduleBranchAttributionEvidence(rawSessionId); }
      catch { console.warn('[AgentEvidence] BRANCH_ATTRIBUTION_DELIVERY_PENDING'); }
    },
    observePreferenceSkillSource: () => {
      try { schedulePreferenceInferenceEvidence(rawSessionId); }
      catch { console.warn('[AgentEvidence] PREFERENCE_INFERENCE_DELIVERY_PENDING'); }
      LEARNING_PREFERENCE_SOURCE_SCHEDULER?.schedule(rawSessionId);
    },
    // The server-side usage observer persists Provider usage whenever the selected Provider returns it.
    providerReportsUsage: true,
    preludeSkillRequired: () => {
      if (!AGENT_ADMISSION_RUNTIME.executionEnabled || !preludeSkillLiveEnabled(process.env)) return false;
      try { return agentAdmissionAllowsSession(parseAgentAdmissionRuntimeConfig(process.env), rawSessionId); }
      catch { return false; }
    },
    criticSkillRequired: () => {
      if (!AGENT_ADMISSION_RUNTIME.executionEnabled || !criticSkillLiveEnabled(process.env)) return false;
      try { return agentAdmissionAllowsSession(parseAgentAdmissionRuntimeConfig(process.env), rawSessionId); }
      catch { return false; }
    },
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
    // Memory/Summary adoption has its own live/source authority, independent of Context Compiler execution.
    prepareMemoryConsumption: (input) => memoryConsumptionAuthority()?.prepare(input) ?? null,
    commitMemoryConsumption: (input) => memoryConsumptionHost?.authority.commit(input) ?? [],
    observeMemoryConsumption: () => {
      MAINTENANCE_MEMORY_CONSUMPTION_SCHEDULER?.schedule(rawSessionId);
      MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.schedule(rawSessionId);
    },
    prepareSummaryConsumption: (input) => summaryConsumptionAuthority()?.prepare(input) ?? null,
    commitSummaryConsumption: (input) => summaryConsumptionHost?.authority.commit(input) ?? [],
    observeSummaryConsumption: () => {
      MAINTENANCE_SUMMARY_CONSUMPTION_SCHEDULER?.schedule(rawSessionId);
      MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.schedule(rawSessionId);
    },
    ...(CONTEXT_COMPILER_RUNTIME.mode === 'shadow' && MODEL_USAGE_COST ? {
      contextCompilerShadowEnabled: () => {
        try { return contextCompilerAllowsShadowSession(parseContextCompilerRuntimeConfig(process.env), rawSessionId); }
        catch { throw new Error('context-shadow-runtime-invalid'); }
      },
      contextCompilerShadowSourceRead: () => CONTEXT_COMPILER_SHADOW_RUNNER.recordSourceRead(),
      offerContextCompilerShadow: (input) => {
        if (input.rawSessionId !== rawSessionId || !sessionDeletionAdmissionOpen(rawSessionId)) return;
        const identity = Object.freeze({ runId: input.runId, sourceRevision: input.sourceRevision,
          contentMode: input.contentMode, historyEpoch: input.historyEpoch, baselineRequestDigest: input.baselineRequestDigest });
        const owner = sessions.get(rawSessionId);
        if (!owner || owner.getHistoryEpoch() !== identity.historyEpoch) return;
        const shadowConfig = parseContextCompilerRuntimeConfig(process.env);
        if (!contextCompilerAllowsShadowSession(shadowConfig, rawSessionId)) return;
        const captured = parseContextCompilerInput({ version: CONTEXT_COMPILER_INPUT_VERSION,
          sources: input.sources, targetTokens: input.targetTokens });
        const manifest = contextCompilerInputManifest(captured);
        const snapshot = snapshotForSession(owner).snapshotToken;
        const worldbook = owner.getWorldbookSourceManifest(true);
        const safetyDigest = () => {
          if (identity.contentMode !== 'nsfw') return 'nsf';
          const dbPath = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
          if (!dbPath) throw new Error('context-shadow-source-invalid');
          const safety = NSFW_SCENE_SAFETY_CONTROL.resolveSnapshot({ dbPath, sessionId: rawSessionId,
            manifest: owner.getWorldbookSourceManifest(true) });
          if (!safety) throw new Error('context-shadow-safety-revoked');
          return sha256Digest(JSON.stringify(safety));
        };
        const expectedSafety = safetyDigest();
        const initialBinding = agentModelBinding();
        const provider = Object.freeze({ providerId: initialBinding.selection.providerId, model: initialBinding.selection.model });
        const client = initialBinding.client;
        const registration = providerRegistry.bindingToken(provider.providerId);
        if (!registration) throw new Error('context-shadow-provider-unavailable');
        const initialRuntime = parseContextCompilerRuntimeConfig(process.env, modelRuntimeProfileFor(provider, client));
        if (!contextCompilerAllowsShadowSession(initialRuntime, rawSessionId) || !initialRuntime.budgetProfile)
          throw new Error('context-shadow-admission-denied');
        const expectedBudgetDigest = agentBudgetProfileDigest(initialRuntime.budgetProfile);
        const inputRate = process.env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK;
        const outputRate = process.env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK;
        if (inputRate !== CONTEXT_COMPILER_SHADOW_RATES.input || outputRate !== CONTEXT_COMPILER_SHADOW_RATES.output)
          throw new Error('context-shadow-pricing-stale');
        // Ephemeral only: never publish or persist provider configuration or credentials.
        const providerBinding = () => sha256Digest(JSON.stringify({ configuration: loadProviderConfig(),
          descriptor: providerRegistry.describe(provider.providerId) }));
        const expectedProviderBinding = providerBinding();
        const current = () => {
          if (!sessionDeletionAdmissionOpen(rawSessionId) || sessions.get(rawSessionId) !== owner
            || !contextCompilerAllowsShadowSession(parseContextCompilerRuntimeConfig(process.env), rawSessionId)
            || owner.getHistoryEpoch() !== identity.historyEpoch || snapshotForSession(owner).snapshotToken !== snapshot
            || owner.getWorldbookSourceManifest(true).sourceRevision !== worldbook.sourceRevision
            || safetyDigest() !== expectedSafety) throw new Error('context-shadow-source-stale');
        };
        const guard = () => {
          current();
          const selected = agentModelBinding().selection;
          const runtime = parseContextCompilerRuntimeConfig(process.env, modelRuntimeProfileFor(provider, client));
          if (selected.providerId !== provider.providerId || selected.model !== provider.model
            || providerRegistry.bindingToken(provider.providerId) !== registration
            || providerBinding() !== expectedProviderBinding
            || process.env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK !== inputRate
            || process.env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK !== outputRate
            || !contextCompilerAllowsShadowSession(runtime, rawSessionId) || !runtime.budgetProfile
            || agentBudgetProfileDigest(runtime.budgetProfile) !== expectedBudgetDigest
            || contextCompilerInputManifest(captured).inputDigest !== manifest.inputDigest)
            throw new Error('context-shadow-binding-stale');
        };
        CONTEXT_COMPILER_SHADOW_RUNNER.enqueue({ sessionId: rawSessionId, work: async (signal, markSent) => {
          guard();
          const live = initialRuntime;
          if (!contextCompilerAllowsShadowSession(live, rawSessionId) || !live.budgetProfile)
            throw new Error('context-shadow-admission-denied');
          const batches = partitionContextCompilerSources(captured.sources,
            Math.max(256, live.budgetProfile.agentInputBudgetTokens - 1_500));
          if (batches.length !== 1) throw new Error('context-shadow-input-budget-exhausted');
          const compiled = buildContextCompilerShadowRequest({ sources: batches[0]!, targetTokens: captured.targetTokens,
            maxInputTokens: live.budgetProfile.agentInputBudgetTokens, maxOutputTokens: live.budgetProfile.agentOutputBudgetTokens });
          const counted: ChatCompletionClient = { ...client,
            complete: (request, signal, call) => client.complete(request, signal, { ...call,
              beforeAdapterDispatch: () => { guard(); markSent(); } }),
            stream: (...args) => client.stream(...args) };
          const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER,
            arbitratedAgentClient(counted, provider, 'context-compiler-shadow', undefined, guard), {
              estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
              onLeaseClosed: recordAgentRuntimeLease, auditRequired: true,
            });
          const sessionId = opaqueLearningToken('session', rawSessionId);
          const ticket = AGENT_ADMISSION_BROKER.issue({ runId: identity.runId, parentRunId: identity.runId,
            sessionId, sourceRevision: identity.sourceRevision, lane: 'interactive', taskKind: 'context_compiler',
            policyVersion: CONTEXT_COMPILER_SHADOW_POLICY_VERSION, modelId: provider.model,
            budgetProfileDigest: agentBudgetProfileDigest(live.budgetProfile), toolSetDigest: agentToolSetDigest([]),
            mode: identity.contentMode, reasonCodes: ['elastic-context-recovery-required'], evidenceDigests: [manifest.sourceDigest],
            noveltyDigest: manifest.inputDigest, expectedBenefit: 'context-recovery',
            limits: admissionLimitsFromBudgetProfile(live.budgetProfile), deadlineMs: Date.now() + live.budgetProfile.maxWallMs,
            allowedTools: [], fullSkillSnapshots: [], cooldownKey: `context-shadow:${sessionId}`,
            idempotencyKey: `shadow:${identity.runId.slice(0, 120)}:${manifest.inputDigest.slice(-16)}`, fallback: 'continue-deterministic' });
          const modelRequest = { ...compiled.request, model: provider.model };
          const response = await gateway.complete({ binding: { ticketId: ticket.ticketId, runId: ticket.runId,
            parentRunId: ticket.parentRunId, sessionId: ticket.sessionId, sourceRevision: ticket.sourceRevision,
            lane: ticket.lane, taskKind: ticket.taskKind, policyVersion: ticket.policyVersion, mode: ticket.mode,
            budgetProfile: live.budgetProfile }, request: modelRequest, signal });
          if (response.finishReason !== 'stop' || response.toolCalls.length !== 0 || typeof response.content !== 'string')
            throw new Error('context-shadow-output-invalid');
          const capsule = parseContextCapsule(response.content, compiled.expectation);
          guard();
          if (!response.usage) throw new Error('context-shadow-usage-unavailable');
          return { baselineRequestDigest: identity.baselineRequestDigest, inputDigest: manifest.inputDigest,
            sourceDigest: manifest.sourceDigest, sourceDigests: captured.sources.map(source => source.sourceDigest),
            sourceTokens: captured.sources.map(source => estimateTokens(source.text)),
            shadowRequestDigest: sha256Digest(JSON.stringify(modelRequest)), capsuleDigest: sha256Digest(JSON.stringify(capsule)),
            targetTokens: captured.targetTokens, promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens };
        } });
      },
    } : {}),
    ...((CONTEXT_COMPILER_RUNTIME.mode === 'test-session' || CONTEXT_COMPILER_RUNTIME.mode === 'canary') && MODEL_USAGE_COST ? {
      ...createContextCompilerSessionHost({ env: process.env, CONTEXT_COMPILER_RUNTIME, CONTEXT_COMPILER_CANARY,
        CONTEXT_CAPSULE_CACHE, AGENT_ADMISSION_BROKER, AGENT_CLOSURE_STORE, AGENT_CLOSURE_RECORDER,
        MODEL_USAGE_COST, SKILL_CONSUMPTION_SCHEDULER, sessions, sessionDeletionAdmissionOpen, agentModelBinding,
        modelRuntimeProfileFor, contextCompilerRuntimeAllows,
        operationHost: () => sessionProviderRuntime().activeHostForSession(rawSessionId),
        turnOperationClientForServer, foregroundSkillHostForSession, arbitratedAgentClient, providerRegistry,
        readProviderGeneration: () => providerConfigurationGeneration, loadProviderConfig, recordAgentRuntimeLease,
        parseContextCompilerRuntimeConfig, partitionContextCompilerSources, createContextCompilerSkillLiveCall,
      }, rawSessionId),
      // P16 C3：交互类工件的消费回执。session 只在回合提交成功之后发，
      // 所以这里不需要再判定"是否真的被用上"——提交本身就证明它进了这一回合。
      observeInteractiveTurn: (input) => {
        AGENT_CLOSURE_RECORDER?.observeInteractiveTurn({
          ...input,
          executionClass: executionClassForLearningSession(agentSessionKind(input.rawSessionId)),
        });
      },
      // P16 C3.3：方向/偏好沉淀的沉淀与应用回执。来源判定与交互/学习 lane 同一套
      // （按会话种类），CAS 仍归学习层自管。
      // P16 W2（用户裁定：变量提案=写入）：同回合完成提案/应用/回读/消费全链。
      observeVariableProposalApplied: (input) => {
        AGENT_CLOSURE_RECORDER?.recordVariableProposalApplied({
          ...input,
          executionClass: executionClassForLearningSession(agentSessionKind(input.rawSessionId)),
        });
      },
      // P16 W3（用户裁定：AQL 建议进报表）：advisory，记到 validated 为止。
      // P16 E1（用户裁定：不再跳过效果观测）：负向/不确定由会话侧窗口结算产生。
      observeEffect: (input) => {
        if (shuttingDown || !AGENT_CLOSURE_RECORDER || !AGENT_CLOSURE_STORE || !sessionDeletionAdmissionOpen(rawSessionId))
          throw new Error('effect-observer-unavailable');
        const original = AGENT_CLOSURE_STORE.get(input.operationId);
        const consumed = original?.events.filter(event => event.type === 'context-consumed'
          && event.consumerRunId === input.consumerRunId && event.artifactDigest === input.artifactDigest) ?? [];
        if (!original || original.sessionId !== rawSessionId || consumed.length !== 1)
          throw new Error('effect-observer-consumer-unavailable');
        AGENT_CLOSURE_RECORDER.observeEffect(input);
        if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) throw new Error('effect-observer-fenced');
        const current = AGENT_CLOSURE_STORE.get(input.operationId);
        const matching = current?.events.filter(event => event.type === 'context-consumed'
          && event.consumerRunId === input.consumerRunId && event.artifactDigest === input.artifactDigest) ?? [];
        if (!current || current.sessionId !== rawSessionId || matching.length !== 1
          || JSON.stringify(matching[0]) !== JSON.stringify(consumed[0])) throw new Error('effect-observer-source-drift');
        try { scheduleReportedEffectEvidence(rawSessionId); }
        catch { console.warn('[AgentEvidence] REPORTED_EFFECT_DELIVERY_PENDING'); }
      },
      observeAqlReplan: (input) => {
        AGENT_CLOSURE_RECORDER?.observeAqlReplan({
          ...input,
          executionClass: executionClassForLearningSession(agentSessionKind(input.rawSessionId)),
        });
      },
      observeDirectionConsolidation: (input) => {
        AGENT_CLOSURE_RECORDER?.beginDirectionConsolidation({
          ...input,
          executionClass: executionClassForLearningSession(agentSessionKind(input.rawSessionId)),
        });
      },
      observeDirectionApplication: (input) => {
        AGENT_CLOSURE_RECORDER?.observeDirectionApplication({
          ...input,
          executionClass: executionClassForLearningSession(agentSessionKind(input.rawSessionId)),
        });
      },
    } : {}),
    ...(AGENT_ADMISSION_RUNTIME.executionEnabled
      && MODEL_USAGE_COST
      ? {
          requestAqlReplan: async (input) => {
            const skillLive = aqlReplanSkillLiveEnabled(process.env);
            const {
              rawSessionId,
              ticketSessionId,
              runId,
              sourceRevision,
              contentMode,
              prompt,
              signal,
              isCurrent: readCurrent,
            } = input;
            const inputSnapshot = parseAqlReplanInput(input.inputSnapshot);
            const inputCurrent = (): boolean => {
              try {
                return (
                  !signal?.aborted &&
                  readCurrent() === true &&
                  agentAdmissionAllowsSession(parseAgentAdmissionRuntimeConfig(process.env), rawSessionId)
                );
              } catch {
                return false;
              }
            };
            let summaryEvidence: ReturnType<typeof captureAqlSummaryRequestEvidence> = null;
            let skillSource: ReturnType<typeof captureAqlReplanSkillSource> | null = null;
            const current = (): boolean => inputCurrent()
              && (summaryEvidence === null || isAqlSummaryRequestEvidenceCurrent(summaryEvidence))
              && (skillSource === null || (aqlReplanSkillLiveEnabled(process.env)
                && isAqlReplanSkillSourceCurrent(skillSource)));
            if (
              !inputSnapshot ||
              renderAqlReplanInput(inputSnapshot) !== prompt ||
              typeof readCurrent !== 'function' ||
              runId === 'missing-run' ||
              !MODEL_USAGE_COST ||
              !current()
            ) {
              if (skillLive) throw new Error('aql-replan-skill-input-unavailable');
              return null;
            }
            const skillSession = skillLive ? sessions.get(rawSessionId) : null;
            if (skillLive) {
              if (!AGENT_CLOSURE_STORE || !skillSession || !sessionDeletionAdmissionOpen(rawSessionId)) {
                throw new Error('aql-replan-skill-source-unavailable');
              }
              skillSource = captureAqlReplanSkillSource({ session: skillSession, runId });
              if (skillSource.sessionId !== ticketSessionId || skillSource.round !== input.round
                || skillSource.sourceRevision !== sourceRevision || skillSource.contentMode !== contentMode
                || skillSource.inputDigest !== sha256Digest(prompt)) {
                throw new Error('aql-replan-skill-input-mismatch');
              }
            }
            // Optional historical request-use evidence, never the assistant-only
            // Summary consumption protocol or an AQL suggestion adoption claim.
            try {
              const summarySession = sessions.get(rawSessionId);
              if (summarySession && inputSnapshot.longterm && sessionDeletionAdmissionOpen(rawSessionId)) {
                const memory = summarySession.getMemory().mem;
                const committer = new MemorySummaryMaintenanceCommitter({ sessionId: rawSessionId, memory },
                  () => { throw new Error('aql-summary-request-current-revision-forbidden'); });
                summaryEvidence = captureAqlSummaryRequestEvidence({
                  rawSessionId, runId, round: input.round, contentMode, sourceRevision, prompt,
                  renderedSummary: inputSnapshot.longterm, memory, committer,
                  isCurrent: () => inputCurrent() && sessions.get(rawSessionId) === summarySession
                    && summarySession.getMemory().mem === memory && sessionDeletionAdmissionOpen(rawSessionId),
                });
              }
            } catch { /* Unproven/legacy source keeps its original advisory request, without a receipt. */ }
            if (!current()) {
              if (skillLive) throw new Error('aql-replan-skill-source-stale');
              return null;
            }
            const { selection: provider, client } = agentModelBinding();
            const budgetProfile = agentTaskBudgetProfile(
              'aql_replan',
              process.env,
              {},
              modelRuntimeProfileFor(provider, client),
            );
            const tools = aqlReplanNativeTools('managed');
            const evidenceDigest = sha256Digest(prompt);
            const request = buildAqlReplanRequest(prompt, {
              variant: 'managed', model: provider.model, maxTokens: budgetProfile.agentOutputBudgetTokens,
            });
            const skillHost = skillSource && skillSession ? createAqlReplanSkillHostAuthority({
              source: skillSource, broker: AGENT_ADMISSION_BROKER, controlStore: AGENT_CONTROL_STORE,
              readLaneRuntime: () => parseAgentLaneRuntimeConfig(process.env),
              liveEnabled: () => aqlReplanSkillLiveEnabled(process.env),
              readEligibility: (lease) => ({
                allowed: current() && sessions.get(rawSessionId) === skillSession
                  && sessionDeletionAdmissionOpen(rawSessionId) && agentCapabilityTicketAllowed(AGENT_CONTROL_STORE, lease),
                revision: sha256Digest(JSON.stringify([skillSource!.sourceDigest,
                  sessions.get(rawSessionId) === skillSession, sessionDeletionAdmissionOpen(rawSessionId)])),
              }),
              safetyAuthority: { readForLease: (lease, source) => {
                const dbPath = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
                if (!dbPath) return null;
                return { sessionId: lease.sessionId, sourceRevision: source.sourceRevision,
                  state: NSFW_SCENE_SAFETY_CONTROL.read({ dbPath, sessionId: rawSessionId,
                    manifest: skillSession.getWorldbookSourceManifest() }) };
              } },
            }) : null;
            const skillCall = skillSource && skillHost ? createAqlReplanSkillLiveCall({
              broker: AGENT_ADMISSION_BROKER, source: skillSource, prompt, request, authority: skillHost.authority,
            }) : null;
            const canDispatch = (lease: AgentAdmissionLease): boolean => current()
              && (!skillLive || !!(skillCall && skillHost && skillHost.authorizeDispatch(lease)
                && skillCall.authorizeFixedRequest() && skillCall.authorizeCurrentContext(lease)));
            let physicalLease: AgentAdmissionLease | undefined;
            let closedAudit: AdmittedModelLeaseAudit | undefined;
            let auditRecorded = false;
            const recordClosedAudit = () => {
              if (!closedAudit || auditRecorded) return false;
              auditRecorded = true;
              recordAgentRuntimeLease(closedAudit);
              return true;
            };
            const gateway = new AdmittedModelGateway(
              AGENT_ADMISSION_BROKER,
              arbitratedAgentClient(client, provider, 'aql-replan', undefined, () => {
                // The arbiter may have queued after the Gateway guard. Recheck at
                // the existing physical handoff without aborting the committed turn.
                if (!physicalLease || !AGENT_ADMISSION_BROKER.mayDispatchLease(physicalLease) || !canDispatch(physicalLease)) {
                  throw new AdmittedModelGatewayError('gateway-dispatch-authority-denied');
                }
              }),
              {
                estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
                onLeaseClosed: skillLive ? (audit) => { closedAudit = audit; } : recordAgentRuntimeLease,
                auditRequired: true,
                ...(skillCall ? { prepareRequestRequired: true, prepareRequest: skillCall.prepareRequest } : {}),
                authorizeDispatch: (lease) => {
                  physicalLease = lease;
                  return canDispatch(lease);
                },
              },
            );
            const ticket = AGENT_ADMISSION_BROKER.issue({
              runId,
              parentRunId: runId,
              sessionId: ticketSessionId,
              sourceRevision,
              lane: 'interactive',
              taskKind: 'aql_replan',
              policyVersion: 'p14-q9r-aql-replan-interactive-v1',
              modelId: provider.model,
              budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
              toolSetDigest: agentToolSetDigest(tools),
              mode: contentMode,
              reasonCodes: ['regenerate-replan-threshold'],
              evidenceDigests: [evidenceDigest],
              noveltyDigest: evidenceDigest,
              expectedBenefit: 'branch-relevance',
              limits: admissionLimitsFromBudgetProfile(budgetProfile),
              deadlineMs: Date.now() + budgetProfile.maxWallMs,
              allowedTools: [],
              fullSkillSnapshots: [],
              cooldownKey: `aql-replan:${ticketSessionId}`,
              idempotencyKey: `admit:${runId.slice(0, 120)}:aql-replan`,
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
                request,
                signal,
              });
              // Session owns the final trim/slice and its pre-truncation length log.
              if (!current() || typeof response.content !== 'string' || !parseAqlReplanOutput(response.content)) {
                if (skillLive) throw new Error('aql-replan-skill-output-invalid');
                return null;
              }
              if (skillCall && skillSession) {
                const proof = skillCall.sealOutput(response.content);
                const permission = physicalLease && skillHost?.permissionSnapshot(physicalLease);
                if (!proof || !permission || !recordClosedAudit() || !current()
                  || skillHost!.permissionSnapshot(physicalLease!) !== permission) {
                  throw new Error('aql-replan-skill-proof-invalid');
                }
                commitAqlReplanSkillSourceReceipt({ rawSessionId, session: skillSession, proof,
                  isCurrentSession: () => current() && sessions.get(rawSessionId) === skillSession
                    && sessionDeletionAdmissionOpen(rawSessionId)
                    && skillHost!.permissionSnapshot(physicalLease!) === permission });
                try { scheduleAqlAdvisoryEvidence(rawSessionId); }
                catch { console.warn('[AgentEvidence] AQL_ADVISORY_DELIVERY_PENDING'); }
              }
              if (summaryEvidence) {
                try { commitAqlSummaryRequestEvidence(summaryEvidence, { request, output: response.content }); }
                catch { /* Optional metadata cannot reverse the already completed turn or retry a model. */ }
              }
              if (!current()) {
                if (skillLive) throw new Error('aql-replan-skill-source-stale');
                return null;
              }
              return response.content;
            } catch {
              skillCall?.abandon();
              if (skillLive) throw new Error('aql-replan-skill-request-failed');
              return null;
            } finally {
              if (skillLive && closedAudit && !auditRecorded) {
                try { recordClosedAudit(); }
                catch { throw new Error('aql-replan-skill-audit-failed'); }
              }
            }
          },
          admitInteractivePrelude: (input) => {
            pendingPreludeSkill = null;
            pendingPreludeSkillCurrent = null;
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
            const skillRequired = preludeSkillLiveEnabled(process.env);
            const session = sessions.get(rawSessionId);
            if (skillRequired && (!AGENT_CLOSURE_STORE || !session)) {
              throw new Error('skill-prelude-host-required');
            }
            const { selection: provider, client: agentTransport } = agentModelBinding();
            const budgetProfile = agentTaskBudgetProfile(
              'interactive_prelude', process.env, {}, modelRuntimeProfileFor(provider, agentTransport),
            );
            // Bind the exact per-session tool projection that the runner will send. Global policy
            // entries whose paths/types are absent from this session must not retain write authority.
            const tools = [...effectiveInteractiveNativeTools(input.variableSpecs)];
            const allowedTools = tools.map((entry) => {
              const fn = (entry as { function?: { name?: unknown } }).function;
              if (typeof fn?.name !== 'string') throw new Error('interactive-tool-contract-invalid');
              return fn.name;
            });
            const policyVersion = input.audit.decision.verdict === 'would-admit'
              ? input.audit.decision.policyVersion : input.director.policyVersion;
            const skillHost = AGENT_CLOSURE_STORE && skillRequired && session
              ? foregroundSkillHostForSession(rawSessionId, session, (lease) => {
                const current = parseAgentAdmissionRuntimeConfig(process.env);
                const budget = agentTaskBudgetProfile('interactive_prelude', process.env, {},
                  modelRuntimeProfileFor(provider, agentTransport));
                return { revision: agentBudgetProfileDigest(budget), allowed: agentAdmissionAllowsSession(current, rawSessionId)
                  && agentBudgetProfileDigest(budget) === lease.budgetProfileDigest };
              }, () => preludeSkillLiveEnabled(process.env)) : null;
            const skillCall = skillHost ? createPreludeSkillLiveCall({ broker: AGENT_ADMISSION_BROKER, policyVersion,
              identity: { rawSessionId: input.rawSessionId, runId: input.runId, sourceRevision: input.sourceRevision },
              executionClass: skillHost.executionClass('interactive', input.ticketSessionId), authority: skillHost.authority,
              captureSource: true }) : null;
            if (skillRequired && (!skillHost || !skillCall)) throw new Error('skill-prelude-host-required');
            let physicalLease: AgentAdmissionLease | undefined;
            let dispatchPermission: string | null | undefined;
            let closedAudit: AdmittedModelLeaseAudit | undefined;
            let auditRecorded = false;
            const recordClosedAudit = () => {
              if (closedAudit && !auditRecorded) { auditRecorded = true; recordAgentRuntimeLease(closedAudit); }
            };
            // P17-01.3：interactive_prelude 前台调用走全局仲裁。
            const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER,
              turnOperationClientForServer(rawSessionId, input.runId, 'prelude',
                arbitratedAgentClient(agentTransport, provider, 'interactive-prelude')), {
              estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
              onLeaseClosed: skillRequired ? (audit) => { closedAudit = audit; } : recordAgentRuntimeLease,
              auditRequired: true,
              ...(skillRequired ? { prepareRequestRequired: true } : {}),
              ...(skillCall ? { prepareRequest: skillCall.prepareRequest, authorizeDispatch: (lease) => {
                physicalLease = lease;
                const current = skillHost!.permissionSnapshot(lease);
                if (dispatchPermission === undefined) dispatchPermission = current;
                return !!current && current === dispatchPermission && skillHost!.authorizeDispatch(lease);
              } } : {}),
            });
            const ticket = AGENT_ADMISSION_BROKER.issue({
              runId: input.runId,
              parentRunId: input.runId,
              sessionId: input.ticketSessionId,
              sourceRevision: input.sourceRevision,
              lane: 'interactive',
              taskKind: 'interactive_prelude',
              policyVersion,
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
            let lastGatewayErrorCode: AdmittedModelGatewayErrorCode | undefined;
            const preserveGatewayError = async <T>(work: () => Promise<T>): Promise<T> => {
              try {
                return await work();
              } catch (error) {
                // Persist only the Gateway's fixed reason vocabulary. Provider messages,
                // prompts and arbitrary thrown text must never enter the control ledger.
                if (error instanceof AdmittedModelGatewayError) {
                  lastGatewayErrorCode = safeAdmittedModelGatewayErrorCode(error);
                }
                throw error;
              }
            };
            const client: ChatCompletionClient = {
              complete: (request, signal) => preserveGatewayError(
                () => lease.complete({ ...request, model: provider.model }, signal),
              ),
              stream: (request, onDelta, onToolArg, signal) => preserveGatewayError(
                () => lease.stream(
                  { ...request, model: provider.model }, onDelta, onToolArg, signal,
                ),
              ),
              capabilities: () => ({ stream: true, tools: true }),
              modelName: () => provider.model,
            };
            return {
              client,
              budgetProfile,
              ...(skillRequired ? { skillRequired: true as const } : {}),
              ...(skillCall ? { sealArtifact: (result) => {
                const sealed = skillCall.sealArtifact(result);
                if (skillRequired && !sealed) throw new Error('skill-prelude-proof-required');
                pendingPreludeSkill = skillCall;
                pendingPreludeSkillCurrent = () => !!dispatchPermission && !!physicalLease
                  && skillHost!.permissionSnapshot(physicalLease) === dispatchPermission;
                if (skillRequired && !pendingPreludeSkillCurrent()) throw new Error('skill-prelude-permission-stale');
              } } : {}),
              finish: (outcome) => {
                if (outcome !== 'completed') { skillCall?.abandon(); pendingPreludeSkill = null; }
                try {
                  lease.finish(outcome,
                    outcome === 'provider_error' ? lastGatewayErrorCode ?? 'gateway-provider-call-failed'
                      : outcome === 'cancelled' ? 'gateway-provider-call-cancelled' : undefined);
                } finally { if (skillRequired) recordClosedAudit(); }
                if (skillRequired && outcome === 'completed' && (!closedAudit || !pendingPreludeSkillCurrent?.())) {
                  pendingPreludeSkill = null; throw new Error('skill-prelude-permission-stale');
                }
              },
            };
          },
          preparePreludeConsumption: (used) => {
            const pending = pendingPreludeSkill;
            pendingPreludeSkill = null;
            const current = pendingPreludeSkillCurrent;
            if ((pending || preludeSkillLiveEnabled(process.env)) && !current?.()) throw new Error('skill-prelude-permission-stale');
            const payload = pending?.prepareConsumption(used) ?? null;
            if (preludeSkillLiveEnabled(process.env) && !payload) throw new Error('skill-prelude-proof-required');
            return payload;
          },
          assertPreludeSkillCurrent: () => {
            if (!pendingPreludeSkillCurrent?.()) throw new Error('skill-prelude-permission-stale');
          },
          observePreludeConsumption: () => SKILL_CONSUMPTION_SCHEDULER?.schedule(rawSessionId),
          repairDraft: async (input) => {
            pendingCriticSkill = null;
            pendingCriticSkillCurrent = null;
            let live;
            try { live = parseAgentAdmissionRuntimeConfig(process.env); } catch { return null; }
            if (!agentAdmissionAllowsSession(live, input.rawSessionId)
              || input.decision.severity !== 'repairable'
              || input.decision.hardDenyCodes.length > 0
              || input.runId === 'missing-run') return null;
            const skillRequired = criticSkillLiveEnabled(process.env);
            const session = sessions.get(rawSessionId);
            if (skillRequired && (!AGENT_CLOSURE_STORE || !session)) throw new Error('skill-critic-host-required');
            const { selection: provider, client } = agentModelBinding();
            const budgetProfile = agentTaskBudgetProfile(
              'critic_revision', process.env, {}, modelRuntimeProfileFor(provider, client),
            );
            const capturedInput = createCriticInput({ decision: input.decision, draft: input.draft,
              fullSkills: input.fullSkills, maxOutputTokens: budgetProfile.agentOutputBudgetTokens });
            const request = { ...buildPrecommitCriticRequestFromInput(capturedInput), model: provider.model };
            const tools: Record<string, unknown>[] = [];
            const skillHost = AGENT_CLOSURE_STORE && skillRequired && session
              ? foregroundSkillHostForSession(rawSessionId, session, (lease) => {
                const current = parseAgentAdmissionRuntimeConfig(process.env);
                const budget = agentTaskBudgetProfile('critic_revision', process.env, {}, modelRuntimeProfileFor(provider, client));
                return { revision: agentBudgetProfileDigest(budget), allowed: agentAdmissionAllowsSession(current, rawSessionId)
                  && agentBudgetProfileDigest(budget) === lease.budgetProfileDigest };
              }, () => criticSkillLiveEnabled(process.env)) : null;
            const skillCall = skillHost ? createCriticSkillLiveCall({
              broker: AGENT_ADMISSION_BROKER, policyVersion: input.decision.policyVersion,
              identity: { rawSessionId: input.rawSessionId, runId: input.runId, sourceRevision: input.sourceRevision,
                draftDigest: sha256Digest(JSON.stringify(input.draft)), decisionDigest: sha256Digest(JSON.stringify(input.decision)) },
              executionClass: skillHost.executionClass('critic', input.ticketSessionId), authority: skillHost.authority,
              sourceManifest: criticInputManifest(capturedInput), sourceRequest: request,
            }) : null;
            if (skillRequired && (!skillHost || !skillCall)) throw new Error('skill-critic-host-required');
            let physicalLease: AgentAdmissionLease | undefined;
            let dispatchPermission: string | null | undefined;
            let closedAudit: AdmittedModelLeaseAudit | undefined;
            let auditRecorded = false;
            const recordClosedAudit = () => {
              if (closedAudit && !auditRecorded) { auditRecorded = true; recordAgentRuntimeLease(closedAudit); }
            };
            const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER,
              turnOperationClientForServer(rawSessionId, input.runId, 'critic',
                arbitratedAgentClient(client, provider, 'critic-revision')), {
              estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
              onLeaseClosed: skillRequired ? (audit) => { closedAudit = audit; } : recordAgentRuntimeLease,
              auditRequired: true,
              ...(skillRequired ? { prepareRequestRequired: true } : {}),
              ...(skillCall ? { prepareRequest: skillCall.prepareRequest, authorizeDispatch: (lease) => {
                physicalLease = lease;
                const current = skillHost!.permissionSnapshot(lease);
                if (dispatchPermission === undefined) dispatchPermission = current;
                return !!current && current === dispatchPermission && skillHost!.authorizeDispatch(lease);
              } } : {}),
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
              request, signal: input.signal,
            });
            if (skillCall && typeof response.content === 'string') {
              skillCall.bindResponse(sha256Digest(response.content));
              pendingCriticSkill = skillCall;
            }
            if (skillRequired && !pendingCriticSkill) throw new Error('skill-critic-proof-required');
            if (skillRequired) {
              const permission = dispatchPermission;
              recordClosedAudit();
              if (!closedAudit || !permission || !physicalLease
                || skillHost!.permissionSnapshot(physicalLease) !== permission) throw new Error('skill-critic-permission-stale');
              pendingCriticSkillCurrent = () => skillHost!.permissionSnapshot(physicalLease!) === permission;
            }
            return response.content;
            } finally { if (skillRequired) recordClosedAudit(); }
          },
          prepareCriticConsumption: (used) => {
            const pending = pendingCriticSkill;
            pendingCriticSkill = null;
            const current = pendingCriticSkillCurrent;
            if ((pending || criticSkillLiveEnabled(process.env)) && !current?.()) throw new Error('skill-critic-permission-stale');
            const payload = pending?.prepareConsumption(used) ?? null;
            if (criticSkillLiveEnabled(process.env) && !payload) throw new Error('skill-critic-proof-required');
            return payload;
          },
          assertCriticSkillCurrent: () => {
            if (!pendingCriticSkillCurrent?.()) throw new Error('skill-critic-permission-stale');
          },
          observeCriticConsumption: () => SKILL_CONSUMPTION_SCHEDULER?.schedule(rawSessionId),
          summarizeRolling: async (input) => {
            let live;
            try { live = parseAgentAdmissionRuntimeConfig(process.env); } catch { return null; }
            if (!agentAdmissionAllowsSession(live, input.rawSessionId)
              || input.runId === 'missing-run' || !MODEL_USAGE_COST) return null;
            const { selection: provider, client: rawSummaryClient } = agentModelBinding();
            // P17-01.3：rolling_summary 维护（lane=maintenance）走全局仲裁。
            const client = turnOperationClientForServer(rawSessionId, input.runId, 'summary',
              arbitratedAgentClient(rawSummaryClient, provider, 'maintenance'));
            const budgetProfile = foregroundSummaryBudgetProfile(
              process.env, modelRuntimeProfileFor(provider, client),
            );
            const tools = [...foregroundSummaryNativeTools()];
            const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, client, {
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
            const response = await lease.complete(buildForegroundSummaryModelRequest({
              model: provider.model, prompt: input.prompt,
              maxOutputTokens: budgetProfile.agentOutputBudgetTokens,
            }), input.signal);
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
                maxOutputTokens: 800,
              }),
              maxOutputTokens: 800,
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
            ...styleCompileAdmissionForSession(rawSessionId),
          } : {}),
  };
}

const sessionLoadPromises = new Map<string, Promise<ChatSession | undefined>>();
function toolResultBodyAccessForSession(
  sessionId: string,
  readSession: () => ChatSession | undefined,
): () => { readonly readAllowed: boolean; readonly writeAllowed: boolean; readonly deletionOpen: boolean } {
  return createToolResultBodyAccess({
    serverAllowed: () => !shuttingDown,
    isCurrentSession: () => {
      const session = readSession();
      return !!session && sessions.get(sessionId) === session;
    },
    deletionOpen: () => sessionDeletionAdmissionOpen(sessionId),
  });
}
function nsfwSceneSkillForSession(rawSessionId: string): NonNullable<SessionArgs['nsfwSceneSkill']> {
  return createNsfwSceneSkillHost({
    liveEnabled: () => nsfwSceneSkillLiveEnabled(process.env),
    readCurrent(source) {
      if (shuttingDown || source.sessionId !== rawSessionId || !sessionDeletionAdmissionOpen(rawSessionId)) return null;
      const session = sessions.get(rawSessionId);
      const dbPath = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!session || !dbPath || session.getHistoryEpoch() !== source.historyEpoch) return null;
      const manifest = session.getWorldbookSourceManifest(true);
      const safety = NSFW_SCENE_SAFETY_CONTROL.resolveSnapshot({ dbPath, sessionId: rawSessionId, manifest });
      if (!safety || manifest.sourceRevision !== source.sourceRevision
        || nsfwSceneRequestDigest(safety) !== source.safetyDigest) return null;
      const turn = session.readAgentSkillTurnContext(source.runId);
      return turn && turn.contentMode === 'nsfw' ? { turn, sessionIdentity: session } : null;
    },
  });
}
async function loadSessionById(sessionId: string): Promise<ChatSession | undefined> {
  if (shuttingDown || !sessionDeletionAdmissionOpen(sessionId)) return undefined;
  const loaded = sessions.get(sessionId);
  if (loaded) return loaded;
  const pending = sessionLoadPromises.get(sessionId);
  if (pending) return pending;
  const promise = (async () => {
    const dbPath = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
    if (!dbPath || !existsSync(dbPath)) return undefined;
    let session: ChatSession;
    session = new ChatSession({
      db: dbPath,
      resume: true,
      useBge: false,
      ...sessionProviderArgsForServer(sessionId),
      toolResultBodyAccess: toolResultBodyAccessForSession(sessionId, () => session),
      skillSelectionObserver: skillSelectionObserverForSession(sessionId),
      stylePackageShadowRequired: () => STYLE_PACKAGE_SHADOW_ENABLED && SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.allowsSession(sessionId),
      stylePackageShadowRejected: input => STYLE_PACKAGE_SHADOW.rejectTurn(input),
      stylePackageCanary: STYLE_PACKAGE_CANARY,
      learnedStyleResolver: learnedStyleResolverForSession(sessionId),
      commitLearnedStyleAdoption: learnedStyleAdoptionForSession(sessionId),
      aqlReplanSkillRequired: () => aqlReplanSkillLiveEnabled(process.env),
      interactiveHarness: interactiveHarnessForSession(sessionId),
      agentAdmission: agentAdmissionForSession(sessionId),
      variableProposalSkill: variableProposalSkillForSession(sessionId),
      nsfwSceneSkill: nsfwSceneSkillForSession(sessionId),
      nsfwSceneSafetyResolver: () => NSFW_SCENE_SAFETY_CONTROL.resolveSnapshot({
        dbPath,
        sessionId,
        manifest: session.getWorldbookSourceManifest(),
      }),
      maintenanceHistoryReconcile: ({ sessionId: callbackSessionId, rollbackRound, historyEpoch }) => {
        if (callbackSessionId !== sessionId || session.getHistoryEpoch() !== historyEpoch) {
          throw new Error('maintenance-history-reconcile-fence-mismatch');
        }
        const committer = new MemorySummaryMaintenanceCommitter({
          sessionId,
          memory: session.getMemory().mem,
        }, () => snapshotForSession(session).snapshotToken);
        const reconciled = committer.reconcileHistoryRollback(rollbackRound);
        // This callback runs in the history transaction: wake only after its synchronous
        // stack exits, then re-read the committed epoch rather than trusting the hint.
        queueMicrotask(() => STYLE_COMPILE_RUNTIME?.wakeSession(sessionId));
        if (reconciled.rolledBackRunIds.length > 0) {
          MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
          MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
          queueMicrotask(() => {
            MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.schedule(sessionId);
            MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.schedule(sessionId);
          });
        }
      },
      quietLogs: ACCESS_MODE === 'secured',
    });
    await session.init();
    // A deletion reservation may have been acquired while the database was
    // initializing.  Never publish that now-fenced instance back into memory.
    if (shuttingDown || !sessionDeletionAdmissionOpen(sessionId)) {
      try { session.close(); } catch { /* deletion cleanup owns the durable truth */ }
      return undefined;
    }
    try {
      reconcileAndHydrateLearning(session);
    } catch {
      if (!learningDrainWarningEmitted) {
        learningDrainWarningEmitted = true;
        console.warn('[AgentLearning] RECONCILE_FAILED（使用 session outbox 本地投影继续）');
      }
    }
    sessions.set(sessionId, session);
    STYLE_COMPILE_RUNTIME?.wakeSession(sessionId);
    SKILL_CONSUMPTION_SCHEDULER?.schedule(sessionId);
    LEARNING_PREFERENCE_SOURCE_SCHEDULER?.schedule(sessionId);
    EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER?.schedule(sessionId);
    CLOSURE_SKILL_EVIDENCE_SCHEDULER?.schedule(sessionId);
    MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.schedule(sessionId);
    MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.schedule(sessionId);
    MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER?.schedule(sessionId);
    MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER?.schedule(sessionId);
    ARC_COMMIT_EVIDENCE_SCHEDULER?.schedule(sessionId);
    WORLDBOOK_APPLY_EVIDENCE_SCHEDULER?.schedule(sessionId);
    NPC_OPERATION_EVIDENCE_SCHEDULER?.schedule(sessionId);
    REGENERATION_EVIDENCE_SCHEDULER?.schedule(sessionId);
    STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER?.schedule(sessionId);
    VARIABLE_APPLY_EVIDENCE_SCHEDULER?.schedule(sessionId);
    VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER?.schedule(sessionId);
    REPORTED_EFFECT_EVIDENCE_SCHEDULER?.schedule(sessionId);
    BRANCH_MODIFIED_EVIDENCE_SCHEDULER?.schedule(sessionId);
    BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER?.schedule(sessionId);
    PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER?.schedule(sessionId);
    AQL_ADVISORY_EVIDENCE_SCHEDULER?.schedule(sessionId);
    NSFW_SCENE_EVIDENCE_SCHEDULER?.schedule(sessionId);
    MAINTENANCE_MEMORY_CONSUMPTION_SCHEDULER?.schedule(sessionId);
    MAINTENANCE_SUMMARY_CONSUMPTION_SCHEDULER?.schedule(sessionId);
    MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
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

function maintenanceProposalControlFor(
  proposalSessionId: string,
  proposalSession: ChatSession,
): MaintenanceProposalControl {
  if (!ARC_PROJECTIONS) throw new Error('maintenance-proposal-control-unavailable');
  const currentRevision = (sessionId: string): string => {
    if (sessionId !== proposalSessionId) throw new Error('maintenance-proposal-session-conflict');
    return snapshotForSession(proposalSession).snapshotToken;
  };
  const npcBackup = new NpcMaintenanceApplyBackupStore({
    dataDir: DATA_DIR,
    currentRevision,
  });
  const memorySummary = new MemorySummaryMaintenanceCommitter({
    sessionId: proposalSessionId,
    memory: proposalSession.getMemory().mem,
  }, currentRevision);
  return new MaintenanceProposalControl({
    manager: maintenanceJobs,
    arcStore: ARC_PROJECTIONS,
    currentRevision,
    prepareNpcApply: (pending) => npcBackup.prepare({
      sessionId: pending.sessionId,
      sourceRevision: pending.sourceRevision,
    }),
    recoverMemorySummaryProposal: (pending) => pending.taskKind === 'memory_consolidation'
      ? withMaintenanceMemoryWriteWake(() => memorySummary.recover(pending),
        () => MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule())
      : withMaintenanceSummaryWriteWake(() => memorySummary.recover(pending),
        () => MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule()),
    applyMemorySummaryProposal: (pending) => pending.taskKind === 'memory_consolidation'
      ? withMaintenanceMemoryWriteWake(() => memorySummary.commit(pending),
        () => MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule())
      : withMaintenanceSummaryWriteWake(() => memorySummary.commit(pending),
        () => MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule()),
    rollbackMemorySummaryProposal: (anchor) => withMaintenanceMemoryWriteWake(() => {
      const result = memorySummary.rollback(anchor);
      // Optional evidence recovery cannot change the already committed rollback outcome.
      for (const scheduler of [MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER, MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER]) {
        try { scheduler?.schedule(proposalSessionId); } catch { /* retained receipts recover on the next wake */ }
      }
      return result;
    },
      () => {
        MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
        MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
      }),
    observeProposalTransition: (proposal) => {
      if (proposal.taskKind === 'branch_index' && ['applied', 'rolled_back'].includes(proposal.status)) {
        try { scheduleArcCommitEvidence(proposal.sessionId); }
        catch { console.warn('[AgentEvidence] ARC_COMMIT_DELIVERY_PENDING'); }
      }
      if (proposal.taskKind === 'npc_state' && ['applied', 'rolled_back'].includes(proposal.status)) {
        try { scheduleNpcOperationEvidence(proposal.sessionId); }
        catch { console.warn('[AgentEvidence] NPC_OPERATION_DELIVERY_PENDING'); }
      }
      if (proposal.status === 'applied' || proposal.status === 'rolled_back') {
        try { scheduleMaintenanceProposalApprovalEvidence(proposal.sessionId, proposal.proposalId); }
        catch { /* Original decision metadata remains available for startup recovery. */ }
      }
      if (proposal.status === 'rejected') {
        try { scheduleMaintenanceProposalRejectionEvidence(proposal.sessionId, proposal.proposalId); }
        catch { /* Original committed rejection remains available for startup recovery. */ }
      }
      const job = maintenanceJobs.get(proposal.jobRunId);
      let summaryOwnsEvidence = false;
      if (proposal.taskKind === 'rolling_summary') {
        try { summaryOwnsEvidence = maintenanceJobs.readSummarySkillProvenance(proposal.jobRunId) !== null; }
        catch { summaryOwnsEvidence = true; AGENT_CLOSURE_DEGRADED = true; }
      }
      if (job && !summaryOwnsEvidence) AGENT_CLOSURE_RECORDER?.observeMaintenanceProposal(job, proposal);
      if (proposal.taskKind === 'memory_consolidation') MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
      if (proposal.taskKind === 'rolling_summary') MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
    },
    ...createNpcMaintenanceProposalAdapters({ dataDir: DATA_DIR, currentRevision }),
  });
}

function npcOccupiedFactTargets(
  projections: ReturnType<ChatSession['getCharacterProjections']>,
  context: NpcMaintenanceProposalContext,
): readonly NpcApplyOccupiedFactTarget[] {
  const allowed = new Set(context.allowedCharacterIds);
  const targets: NpcApplyOccupiedFactTarget[] = [];
  for (const projection of projections) {
    if (!allowed.has(projection.characterId)) continue;
    for (const field of Object.keys(projection.profile)) {
      targets.push({ characterId: projection.characterId, scope: 'profile', field });
    }
    for (const field of Object.keys(projection.facts)) {
      targets.push({ characterId: projection.characterId, scope: 'fact', field });
    }
  }
  return Object.freeze(targets.sort((left, right) => (
    `${left.characterId}\0${left.scope}\0${left.field}`
      .localeCompare(`${right.characterId}\0${right.scope}\0${right.field}`)
  )).map((target) => Object.freeze(target)));
}

function npcMaintenanceReviewItems(
  pending: import('./maintenance-job-manager.ts').MaintenancePendingProposalRecord,
  session: ChatSession,
): readonly PublicMaintenanceProposalReviewItem[] | undefined {
  if (pending.taskKind !== 'npc_state' || !('allowedCharacterIds' in pending.context)) return undefined;
  try {
    const context = pending.context as NpcMaintenanceProposalContext;
    const proposal = normalizeNpcMaintenanceProposal(pending.proposal.payload, context);
    const projections = session.getCharacterProjections();
    const characterNames = new Map(projections.map((projection) => [
      projection.characterId,
      projection.identity.name,
    ]));
    const policy = evaluateNpcApplyPolicy(proposal, {
      remainingAutoWrites: NPC_APPLY_POLICY_LIMITS.maxAutoWritesPerProposal,
      occupiedFactTargets: npcOccupiedFactTargets(projections, context),
      occupiedRelationshipTargets: npcOccupiedRelationshipTargets(
        projections, context.allowedCharacterIds,
      ),
    });
    const label = (characterId: string): string => (
      `${characterNames.get(characterId) ?? '未命名人物'}（${characterId}）`
    );
    const candidates = proposal.entries.map((entry, entryIndex) => {
      const decision = policy.entryDecisions[entryIndex]!;
      if (entry.kind === 'unresolved') {
        return {
          kind: 'unresolved' as const,
          title: '存在尚未解析到稳定人物的提及',
          detail: `原因：${entry.reasonCode}；提及摘要：${entry.mentionDigest}`,
          write: false,
          decision: decision.verdict,
          reasonCodes: [...decision.reasonCodes],
          sourceRefs: [...entry.sourceRefs],
        };
      }
      if (entry.kind === 'identity_resolution') {
        return {
          kind: 'identity' as const,
          title: `为 ${label(entry.characterId)} 添加别名“${entry.alias}”`,
          detail: `识别键：${entry.mentionKey}；置信度：${entry.confidence}；预期人物版本：${entry.expectedEntityVersion}`,
          write: true,
          decision: decision.verdict,
          reasonCodes: [...decision.reasonCodes],
          sourceRefs: [...entry.sourceRefs],
        };
      }
      if (entry.kind === 'relationship') {
        return {
          kind: 'relationship' as const,
          title: `${label(entry.characterId)} → ${label(entry.toCharacterId)}：${entry.relationType}`,
          detail: `视角：${entry.perspective}；状态：${entry.status}；置信度：${entry.confidence}；证据轮次：R${entry.effectiveRound}；预期人物版本：${entry.expectedEntityVersion}`,
          write: true,
          decision: decision.verdict,
          reasonCodes: [...decision.reasonCodes],
          sourceRefs: [...entry.sourceRefs],
        };
      }
      const serialized = JSON.stringify(entry.value);
      return {
        kind: 'fact' as const,
        title: `${label(entry.characterId)}：${entry.kind}.${entry.field}`,
        detail: `拟写值：${serialized ?? 'null'}；状态：${entry.status}；置信度：${entry.confidence}；证据轮次：R${entry.effectiveRound}；预期人物版本：${entry.expectedEntityVersion}`,
        write: true,
        decision: decision.verdict,
        reasonCodes: [...decision.reasonCodes],
        sourceRefs: [...entry.sourceRefs],
      };
    });
    const complete = npcReviewProposalHasCompleteWriteReview(candidates);
    return Object.freeze(candidates.map((candidate): PublicMaintenanceProposalReviewItem => Object.freeze({
      kind: candidate.kind,
      title: boundedNpcReviewText(
        candidate.title, PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
      ),
      detail: boundedNpcReviewText(
        candidate.detail, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
      ),
      applicable: candidate.write && complete,
      decision: candidate.decision,
      reasonCodes: Object.freeze([...new Set([
        ...candidate.reasonCodes,
        ...(candidate.write && !complete ? ['proposal-review-incomplete'] : []),
      ])]),
      sourceRefs: Object.freeze([...candidate.sourceRefs]),
    })));
  } catch {
    // A proposal that no longer passes the current schema must never become a
    // local blind-approval surface. The caller omits reviewItems and the UI blocks apply.
    return undefined;
  }
}

function maintenanceProposalReviewItems(
  pending: import('./maintenance-job-manager.ts').MaintenancePendingProposalRecord,
  session?: ChatSession,
): readonly PublicMaintenanceProposalReviewItem[] | undefined {
  if (pending.status !== 'pending') return undefined;
  const typedReview = typedMaintenanceProposalReviewItems(pending);
  if (typedReview) return typedReview;
  if (!session || !shouldExposeDynamicNpcReviewItems({
    mutationAllowed: true,
    sessionLoaded: true,
    taskKind: pending.taskKind,
    status: pending.status,
  })) return undefined;
  return npcMaintenanceReviewItems(pending, session);
}

async function applyGuardedNpcProposal(job: import('./maintenance-types.ts').PublicMaintenanceJob): Promise<void> {
  if (job.taskKind !== 'npc_state'
    || !maintenanceGuardedAutoAllowsNpcSession(MAINTENANCE_APPLY_RUNTIME, job.sessionId)
    || !maintenanceTaskExecutionAllowed(job.sessionId, 'npc_state')) return;
  const pending = maintenanceJobs.getProposalForJob(job.runId);
  if (!pending || pending.status !== 'pending' || pending.taskKind !== 'npc_state'
    || !('allowedCharacterIds' in pending.context)) return;
  const session = await loadSessionById(pending.sessionId);
  if (!session || !maintenanceTaskExecutionAllowed(pending.sessionId, 'npc_state')) return;
  const context = pending.context as NpcMaintenanceProposalContext;
  const proposal = normalizeNpcMaintenanceProposal(pending.proposal.payload, context);
  const projections = session.getCharacterProjections();
  const occupiedFactTargets = npcOccupiedFactTargets(projections, context);
  const occupiedRelationshipTargets = npcOccupiedRelationshipTargets(
    projections, context.allowedCharacterIds,
  );
  const decision = evaluateNpcApplyPolicy(proposal, {
    remainingAutoWrites: NPC_APPLY_POLICY_LIMITS.maxAutoWritesPerProposal,
    occupiedFactTargets,
    occupiedRelationshipTargets,
  });
  // approve() is synchronous. This final check therefore closes the last
  // stop/write race without leaving an await between authorization and CAS.
  if (decision.verdict !== 'auto'
    || !maintenanceTaskExecutionAllowed(pending.sessionId, 'npc_state')) return;
  maintenanceProposalControlFor(pending.sessionId, session).approve(
    pending.proposalId,
    pending.revision,
    'guarded-auto-approved',
    Object.freeze({
      version: 'npc-guarded-auto-audit-v1' as const,
      policyVersion: decision.policyVersion,
      proposalDigest: decision.proposalDigest,
      reasonCodes: Object.freeze([...decision.reasonCodes]),
      approvedAutoWrites: decision.approvedAutoWrites,
      occupiedTargetsDigest: sha256Digest(JSON.stringify({ occupiedFactTargets, occupiedRelationshipTargets })),
      entryDecisions: Object.freeze(decision.entryDecisions.map((entry) => Object.freeze({
        entryIndex: entry.entryIndex,
        verdict: entry.verdict,
        reasonCodes: Object.freeze([...entry.reasonCodes]),
      }))),
    }),
  );
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

/**
 * 世界书修正：只把模型产出的提案**登记**到控制面（pending 状态），
 * **绝不自动 approve / apply** —— 落地必须由本地操作者在审阅弹窗里确认（这正是本功能的设计前提）。
 * `JG_WORLDBOOK_REPAIR` forward 开关关闭时登记会被控制面拒绝，属预期行为。
 */
async function registerWorldbookRepairProposal(
  input: Parameters<NonNullable<MaintenanceHarnessServiceOptions['onWorldbookRepairProposal']>>[0],
): Promise<import('./maintenance-harness-service.ts').WorldbookSkillProposalRegistration | void> {
  if (Object.hasOwn(input, 'worldbookSkillProof')) {
    if (input.job.taskKind !== 'worldbook_repair' || !WORLDBOOK_REPAIR_CONTROL_PLANE || !WORLDBOOK_REPAIR_CONTROL
      || !input.worldbookSkillProof || !isWorldbookRepairProposalContext(input.context)
      || typeof input.assertCurrent !== 'function') throw new Error('maintenance-worldbook-skill-registration-required');
    input.assertCurrent();
    const created = await WORLDBOOK_REPAIR_CONTROL_PLANE.create({
      operationId: `worldbook-repair:${input.job.runId}`, proposal: input.proposal.payload,
      skillProof: input.worldbookSkillProof, context: input.context, assertCurrent: input.assertCurrent,
    });
    input.assertCurrent();
    const source = WORLDBOOK_REPAIR_CONTROL.readSkillProvenance(created.proposalId);
    if (!source || source.record.proposalId !== created.proposalId
      || source.record.operationId !== `worldbook-repair:${input.job.runId}`
      || source.record.sessionId !== input.job.sessionId || source.record.proposalDigest !== created.proposalDigest
      || source.record.proof.proofDigest !== input.worldbookSkillProof.proofDigest
      || source.proposal.status !== 'pending' || source.proposal.revision !== created.revision) {
      throw new Error('maintenance-worldbook-skill-registration-invalid');
    }
    return Object.freeze({ proposalId: created.proposalId, operationId: source.record.operationId,
      sessionId: source.record.sessionId, proposalDigest: source.record.proof.proposalDigest,
      proofDigest: source.record.proof.proofDigest });
  }
  if (input.job.taskKind !== 'worldbook_repair' || !WORLDBOOK_REPAIR_CONTROL_PLANE) return;
  if (!isWorldbookRepairProposalContext(input.context)) return;
  try {
    // operationId 绑定 runId ⇒ 同一次模型产出重放时控制面返回原结果，不产生重复提案。
    await WORLDBOOK_REPAIR_CONTROL_PLANE.create({
      operationId: `worldbook-repair:${input.job.runId}`,
      proposal: input.proposal.payload,
    });
  } catch {
    // 固定文案：提案/模型/用户内容一律不进日志。forward 开关（JG_WORLDBOOK_REPAIR）关闭时也走这里。
    console.warn('[worldbook-repair] proposal registration failed detail=redacted');
  }
}

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
 * 客户端据此触发全量 refetch；同代际仅提供有界连续 replay，不作为任务历史。
 */
const eventHub = new InvalidationHub({ serverInstanceId: SERVER_INSTANCE_ID });
const DIRECTOR_CREATIVE_ENABLED = process.env.JG_DIRECTOR_CREATIVE_ENABLED === '1';
if (process.env.JG_DIRECTOR_CREATIVE_ENABLED !== undefined && !['0', '1'].includes(process.env.JG_DIRECTOR_CREATIVE_ENABLED))
    throw new Error('director-config-invalid');
const DIRECTOR_NSFW_ENABLED = process.env.JG_DIRECTOR_NSFW_ENABLED === '1';
if (process.env.JG_DIRECTOR_NSFW_ENABLED !== undefined && !['0', '1'].includes(process.env.JG_DIRECTOR_NSFW_ENABLED))
    throw new Error('director-config-invalid');
const DIRECTOR_NSFW_PROVIDER_ID = process.env.JG_DIRECTOR_NSFW_PROVIDER_ID?.trim();
const DIRECTOR_NSFW_MODEL = process.env.JG_DIRECTOR_NSFW_MODEL?.trim();
const DIRECTOR_NSFW_OBSERVER_MODEL = process.env.JG_DIRECTOR_NSFW_OBSERVER_MODEL?.trim();
if (DIRECTOR_NSFW_ENABLED && (!DIRECTOR_NSFW_PROVIDER_ID || !DIRECTOR_NSFW_MODEL || DIRECTOR_NSFW_OBSERVER_MODEL !== 'deepseek-flash'))
    throw new Error('director-nsfw-config-invalid');
function directorNsfwSafetyDigest(owner: string): string | null {
    const session = sessions.get(owner);
    if (!DIRECTOR_NSFW_ENABLED || !session || session.getContentMode() !== 'nsfw' || !sessionDeletionAdmissionOpen(owner) || shuttingDown) return null;
    try {
        const dbPath = resolveSessionDatabase(DATA_DIR, `${owner}.db`);
        if (!dbPath) return null;
        const manifest = session.getWorldbookSourceManifest(true);
        const safety = NSFW_SCENE_SAFETY_CONTROL.resolveSnapshot({ dbPath, sessionId: owner, manifest });
        if (!safety) return null;
        return `sha256:${createHash('sha256').update(JSON.stringify({ safety, manifest })).digest('hex')}`;
    } catch { return null; }
}
function directorSourceAllowed(owner: string): boolean {
    if (!sessionDeletionAdmissionOpen(owner) || shuttingDown) return false;
    const session = sessions.get(owner);
    return !session || session.getContentMode() === 'nsf' || directorNsfwSafetyDigest(owner) !== null;
}
function directorPersistedNsfw(owner: string): boolean {
    const dbPath = resolveSessionDatabase(DATA_DIR, `${owner}.db`);
    if (!dbPath || !existsSync(dbPath)) return false;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const row = db.prepare('SELECT config FROM memory_meta WHERE id=1').get();
        const config = JSON.parse(String(row?.config));
        if (config.mode !== 'nsf' && config.mode !== 'nsfw') throw new Error('director-source-partition-denied');
        return config.mode === 'nsfw';
    } finally { db.close(); }
}
const DIRECTOR_CREATIVE_STORE = DIRECTOR_CREATIVE_ENABLED || existsSync(resolve(DATA_DIR, DIRECTOR_CREATIVE_DB_FILE))
    ? new DirectorCreativeStore({ dataDir: DATA_DIR, allowed: directorSourceAllowed }) : null;
DIRECTOR_CREATIVE_STORE?.recoverInterrupted();
const DIRECTOR_CREATIVE_SERVICE = DIRECTOR_CREATIVE_STORE ? new DirectorCreativeService({
    store: DIRECTOR_CREATIVE_STORE, enabled: () => DIRECTOR_CREATIVE_ENABLED,
    allowed: directorSourceAllowed,
    resolveSource: owner => resolveSessionDatabase(DATA_DIR, `${owner}.db`),
    nsfwSafetyDigest: directorNsfwSafetyDigest,
    modelBinding: partition => {
        if (partition === 'nsf') return agentModelBinding();
        if (!DIRECTOR_NSFW_ENABLED || !DIRECTOR_NSFW_PROVIDER_ID || !DIRECTOR_NSFW_MODEL) throw new Error('director-nsfw-config-invalid');
        const descriptor = providerRegistry.describe(DIRECTOR_NSFW_PROVIDER_ID);
        if (!descriptor?.configured) throw new Error('director-nsfw-provider-unavailable');
        return agentModelBinding({ providerId: DIRECTOR_NSFW_PROVIDER_ID, model: DIRECTOR_NSFW_MODEL });
    },
}) : null;
let agentLoopTaskInvalidationLastWarnAt = 0;
// The durable outbox is a notification transport, never another task executor.
// Polling also observes committed writes by other workers using the same Store.

/** TurnJobService 生命周期 → 白名单失效事件（queued/started/finished|failed|cancelled）。 */
const TURN_JOB_PHASE_EVENT: Record<'queued' | 'running' | 'settled', (job: { status: string }) => EventType> = {
  queued: () => 'turn.queued',
  running: () => 'turn.started',
  settled: (job) => job.status === 'succeeded'
    ? 'turn.finished'
    : job.status === 'cancelled' ? 'turn.cancelled' : 'turn.failed',
};

const MAINTENANCE_RUNTIME = parseMaintenanceRuntimeConfig();
const maintenanceJobs = new MaintenanceJobManager({ dataDir: DATA_DIR, onSkillProvenanceFailure: () => {
  AGENT_CLOSURE_DEGRADED = true;
  console.warn('[maintenance-skill] source persistence failed detail=redacted');
} });
const AGENT_LOOP_SUMMARY_APPLY_OUTCOME_READER = new AgentLoopSummaryApplyOutcomeReader({
  store: AGENT_LOOP_PROJECTION_STORE, manager: maintenanceJobs, allowed: sessionDeletionAdmissionOpen,
  resolveDatabase: (sessionId) => {
    if (!sessionDeletionAdmissionOpen(sessionId)) return null;
    return resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
  },
});
agentLoopTaskInvalidationDrainer = createAgentLoopTaskInvalidationDrainer({
    store: AGENT_LOOP_PROJECTION_STORE,
    summaryApply: AGENT_LOOP_SUMMARY_APPLY_OUTCOME_READER,
    publish: (input, evidence) => {
        publishAgentLoopTaskInvalidation(eventHub, input, evidence);
    },
    onError: () => {
        const now = Date.now();
        if (now - agentLoopTaskInvalidationLastWarnAt < 60_000) return;
        agentLoopTaskInvalidationLastWarnAt = now;
        console.warn('[AgentLoop] task 失效通知未投递，原 outbox 保留待重试');
    },
});
const MAINTENANCE_MEMORY_SKILL_SCHEDULER = AGENT_CLOSURE_STORE ? createMaintenanceMemorySkillProposalScheduler({
  manager: maintenanceJobs, closure: AGENT_CLOSURE_STORE, allowed: sessionDeletionAdmissionOpen,
  onFailure: () => { AGENT_CLOSURE_DEGRADED = true; },
}) : null;
const MAINTENANCE_MEMORY_WRITE_SCHEDULER = AGENT_CLOSURE_STORE ? createMaintenanceMemoryWriteScheduler({
  manager: maintenanceJobs, closure: AGENT_CLOSURE_STORE, allowed: sessionDeletionAdmissionOpen,
  open: (sessionId) => {
    if (!sessionDeletionAdmissionOpen(sessionId)) return null;
    const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
    return path ? openMaintenanceMemoryWriteRecovery(path, sessionId) : null;
  },
  onFailure: () => { AGENT_CLOSURE_DEGRADED = true; },
}) : null;
const MAINTENANCE_SUMMARY_WRITE_SCHEDULER = AGENT_CLOSURE_STORE ? createMaintenanceSummaryWriteScheduler({
  manager: maintenanceJobs, closure: AGENT_CLOSURE_STORE, allowed: sessionDeletionAdmissionOpen,
  open: (sessionId) => {
    if (!sessionDeletionAdmissionOpen(sessionId)) return null;
    const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
    return path ? openMaintenanceSummaryWriteRecovery(path, sessionId) : null;
  },
  onFailure: () => { AGENT_CLOSURE_DEGRADED = true; },
}) : null;
const MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createMaintenanceMemoryEvidenceScheduler({
    manager: maintenanceJobs, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    open: (sessionId) => {
      if (!sessionDeletionAdmissionOpen(sessionId)) return null;
      const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
      return path ? openMaintenanceMemoryEvidenceSource(path, sessionId) : null;
    },
    onFailure: () => console.warn('[AgentEvidence] MEMORY_RECEIPT_DELIVERY_PENDING（原回执保留，等待下次触发）'),
  }) : null;
const MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createMaintenanceSummaryEvidenceScheduler({
    manager: maintenanceJobs, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    open: (sessionId) => {
      if (!sessionDeletionAdmissionOpen(sessionId)) return null;
      const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
      return path ? openMaintenanceSummaryEvidenceSource(path, sessionId) : null;
    },
    onFailure: () => console.warn('[AgentEvidence] SUMMARY_RECEIPT_DELIVERY_PENDING（原回执保留，等待下次触发）'),
  }) : null;
let MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createMaintenanceProposalRejectionEvidenceScheduler({
    manager: maintenanceJobs, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    onFailure: () => console.warn('[AgentEvidence] PROPOSAL_REJECTION_DELIVERY_PENDING（原拒绝回执保留，等待下次触发）'),
  }) : null;
let MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createMaintenanceProposalApprovalEvidenceScheduler({
    manager: maintenanceJobs, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    onFailure: () => console.warn('[AgentEvidence] PROPOSAL_APPROVAL_DELIVERY_PENDING（原审批证据保留，等待下次触发）'),
  }) : null;
let REGENERATION_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createRegenerationEvidenceScheduler({
    ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    open: (sessionId) => {
      if (!sessionDeletionAdmissionOpen(sessionId)) return null;
      const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
      return path ? openRegenerationEvidenceSource(path, sessionId) : null;
    },
    onFailure: () => console.warn('[AgentEvidence] REGENERATION_DELIVERY_PENDING（原重生成事件保留，等待下次触发）'),
  }) : null;
/** Open only after validating the original, session-qualified decision. */
function scheduleMaintenanceProposalApprovalEvidence(rawSessionId: string, proposalId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const original = maintenanceJobs.readApprovedProposalEvidence(proposalId);
      if (!original || original.proposal.sessionId !== rawSessionId
          || !maintenanceProposalApprovalEvidenceRecord(original.proposal, original.job)
          || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER = createMaintenanceProposalApprovalEvidenceScheduler({
      manager: maintenanceJobs, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      onFailure: () => console.warn('[AgentEvidence] PROPOSAL_APPROVAL_DELIVERY_PENDING'),
    });
  }
  MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
function scheduleMaintenanceProposalRejectionEvidence(rawSessionId: string, proposalId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const original = maintenanceJobs.readRejectedProposalEvidence(proposalId);
      if (!original || original.proposal.sessionId !== rawSessionId) return;
      maintenanceProposalRejectionEvidenceRecord(original.proposal, original.job);
      if (!sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER = createMaintenanceProposalRejectionEvidenceScheduler({
      manager: maintenanceJobs, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      onFailure: () => console.warn('[AgentEvidence] PROPOSAL_REJECTION_DELIVERY_PENDING'),
    });
  }
  MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
function scheduleRegenerationEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!REGENERATION_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedRegenerationEvidence(path, rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    REGENERATION_EVIDENCE_SCHEDULER = createRegenerationEvidenceScheduler({
      ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      open: (id) => {
        if (!sessionDeletionAdmissionOpen(id)) return null;
        const path = resolveSessionDatabase(DATA_DIR, `${id}.db`);
        return path ? openRegenerationEvidenceSource(path, id) : null;
      },
      onFailure: () => console.warn('[AgentEvidence] REGENERATION_DELIVERY_PENDING'),
    });
  }
  REGENERATION_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
/** Recover only original user signals; never open a Session or dispatch a Provider. */
function recoverEffectWatchForSession(rawSessionId: string): void {
  if (shuttingDown || !AGENT_CLOSURE_STORE || !AGENT_CLOSURE_RECORDER || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
  if (!path || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  recoverSessionEffectWatch({ path, rawSessionId,
    allowed: id => !shuttingDown && sessionDeletionAdmissionOpen(id),
    closure: AGENT_CLOSURE_STORE, recorder: AGENT_CLOSURE_RECORDER,
    onObserved: id => scheduleReportedEffectEvidence(id) });
}
function wakeEffectWatchRecovery(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  queueMicrotask(() => {
    try { recoverEffectWatchForSession(rawSessionId); }
    catch { console.warn('[AgentClosure] EFFECT_WATCH_RECOVERY_PENDING'); }
  });
}
let STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createStyleCompileAdoptionEvidenceScheduler({
    ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (sessionId) => resolveSessionDatabase(DATA_DIR, `${sessionId}.db`),
    onFailure: () => console.warn('[AgentEvidence] STYLE_ADOPTION_DELIVERY_PENDING'),
  }) : null;
let VARIABLE_APPLY_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createVariableApplyEvidenceScheduler({
    ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (sessionId) => resolveSessionDatabase(DATA_DIR, `${sessionId}.db`),
    onFailure: () => console.warn('[AgentEvidence] VARIABLE_APPLY_DELIVERY_PENDING'),
  }) : null;
/** A first committed adoption may appear after startup with recording disabled and no Ledger yet. */
function scheduleStyleCompileAdoptionEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedStyleCompileAdoptionEvidence(path, rawSessionId)
          || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER = createStyleCompileAdoptionEvidenceScheduler({
      ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] STYLE_ADOPTION_DELIVERY_PENDING'),
    });
  }
  STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
function scheduleVariableApplyEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!VARIABLE_APPLY_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedVariableApplyEvidence(path, rawSessionId)
          || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    VARIABLE_APPLY_EVIDENCE_SCHEDULER = createVariableApplyEvidenceScheduler({
      ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] VARIABLE_APPLY_DELIVERY_PENDING'),
    });
  }
  VARIABLE_APPLY_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createVariableInvalidationEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
    onFailure: () => console.warn('[AgentEvidence] VARIABLE_INVALIDATION_DELIVERY_PENDING') }) : null;
function scheduleVariableInvalidationEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedVariableInvalidationEvidence(path, rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER = createVariableInvalidationEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER,
      allowed: sessionDeletionAdmissionOpen, resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] VARIABLE_INVALIDATION_DELIVERY_PENDING') });
  }
  VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let REPORTED_EFFECT_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER && AGENT_CLOSURE_STORE
  ? createReportedEffectEvidenceScheduler({ dataDir: DATA_DIR, ledger: AGENT_EVIDENCE_LEDGER,
    allowed: sessionDeletionAdmissionOpen, onFailure: () => console.warn('[AgentEvidence] REPORTED_EFFECT_DELIVERY_PENDING') }) : null;
function scheduleReportedEffectEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId) || !AGENT_CLOSURE_STORE) return;
  if (!REPORTED_EFFECT_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      if (!hasRetainedReportedEffects(DATA_DIR, (id) => SESSION_DELETION_JOURNAL.isBlocked(id))
          || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    REPORTED_EFFECT_EVIDENCE_SCHEDULER = createReportedEffectEvidenceScheduler({ dataDir: DATA_DIR,
      ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      onFailure: () => console.warn('[AgentEvidence] REPORTED_EFFECT_DELIVERY_PENDING') });
  }
  REPORTED_EFFECT_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let BRANCH_MODIFIED_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createBranchModifiedEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
    onFailure: () => console.warn('[AgentEvidence] BRANCH_MODIFIED_DELIVERY_PENDING') }) : null;
function scheduleBranchModifiedEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!BRANCH_MODIFIED_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedBranchModifiedEvidence(path, rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    BRANCH_MODIFIED_EVIDENCE_SCHEDULER = createBranchModifiedEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER,
      allowed: sessionDeletionAdmissionOpen, resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] BRANCH_MODIFIED_DELIVERY_PENDING') });
  }
  BRANCH_MODIFIED_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createBranchAttributionEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
    onFailure: () => console.warn('[AgentEvidence] BRANCH_ATTRIBUTION_DELIVERY_PENDING') }) : null;
function scheduleBranchAttributionEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedBranchAttributionEvidence(path, rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER = createBranchAttributionEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER,
      allowed: sessionDeletionAdmissionOpen, resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] BRANCH_ATTRIBUTION_DELIVERY_PENDING') });
  }
  BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createPreferenceInferenceEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
    onFailure: () => console.warn('[AgentEvidence] PREFERENCE_INFERENCE_DELIVERY_PENDING') }) : null;
function schedulePreferenceInferenceEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedPreferenceInferenceEvidence(path, rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER = createPreferenceInferenceEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER,
      allowed: sessionDeletionAdmissionOpen, resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] PREFERENCE_INFERENCE_DELIVERY_PENDING') });
  }
  PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let AQL_ADVISORY_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createAqlAdvisoryEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
    onFailure: () => console.warn('[AgentEvidence] AQL_ADVISORY_DELIVERY_PENDING') }) : null;
function scheduleAqlAdvisoryEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!AQL_ADVISORY_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedAqlAdvisoryEvidence(path, rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    AQL_ADVISORY_EVIDENCE_SCHEDULER = createAqlAdvisoryEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER,
      allowed: sessionDeletionAdmissionOpen, resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] AQL_ADVISORY_DELIVERY_PENDING') });
  }
  AQL_ADVISORY_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let NSFW_SCENE_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createNsfwSceneEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
    onFailure: () => console.warn('[AgentEvidence] SCENE_CONSUMPTION_DELIVERY_PENDING') }) : null;
function scheduleNsfwSceneEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!NSFW_SCENE_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      const path = resolveSessionDatabase(DATA_DIR, `${rawSessionId}.db`);
      if (!path || !hasRetainedNsfwSceneEvidence(path, rawSessionId) || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    NSFW_SCENE_EVIDENCE_SCHEDULER = createNsfwSceneEvidenceScheduler({ ledger: AGENT_EVIDENCE_LEDGER,
      allowed: sessionDeletionAdmissionOpen, resolvePath: (id) => resolveSessionDatabase(DATA_DIR, `${id}.db`),
      onFailure: () => console.warn('[AgentEvidence] SCENE_CONSUMPTION_DELIVERY_PENDING') });
  }
  NSFW_SCENE_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let ARC_COMMIT_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER && ARC_PROJECTIONS
  ? createArcCommitEvidenceScheduler({ manager: maintenanceJobs, arcStore: ARC_PROJECTIONS,
    ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    onFailure: () => console.warn('[AgentEvidence] ARC_COMMIT_DELIVERY_PENDING') }) : null;
function scheduleArcCommitEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!ARC_PROJECTIONS) throw new Error('arc-evidence-store-unavailable');
  if (!ARC_COMMIT_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      if (!hasRetainedArcCommitEvidence(DATA_DIR, (id) => SESSION_DELETION_JOURNAL.isBlocked(id))
          || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    ARC_COMMIT_EVIDENCE_SCHEDULER = createArcCommitEvidenceScheduler({ manager: maintenanceJobs,
      arcStore: ARC_PROJECTIONS, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      onFailure: () => console.warn('[AgentEvidence] ARC_COMMIT_DELIVERY_PENDING') });
  }
  ARC_COMMIT_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let WORLDBOOK_APPLY_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER && WORLDBOOK_REPAIR_CONTROL
  ? createWorldbookApplyEvidenceScheduler({ control: WORLDBOOK_REPAIR_CONTROL,
    ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    onFailure: () => console.warn('[AgentEvidence] WORLDBOOK_APPLY_DELIVERY_PENDING') }) : null;
function observeWorldbookApplyTransition(observation: Parameters<NonNullable<ConstructorParameters<typeof WorldbookRepairControl>[0]['observe']>>[0]): void {
  try { AGENT_CLOSURE_RECORDER?.observeWorldbookRepairTransition(observation); }
  finally {
    if (observation.status === 'applied' || observation.status === 'reverted') {
      try { scheduleWorldbookApplyEvidence(observation.sessionId); }
      catch { console.warn('[AgentEvidence] WORLDBOOK_APPLY_DELIVERY_PENDING'); }
    }
  }
}
function scheduleWorldbookApplyEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!WORLDBOOK_REPAIR_CONTROL) throw new Error('worldbook-evidence-store-unavailable');
  if (!WORLDBOOK_APPLY_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      if (!hasRetainedWorldbookApplyEvidence(DATA_DIR, (id) => SESSION_DELETION_JOURNAL.isBlocked(id))
          || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    WORLDBOOK_APPLY_EVIDENCE_SCHEDULER = createWorldbookApplyEvidenceScheduler({ control: WORLDBOOK_REPAIR_CONTROL, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      onFailure: () => console.warn('[AgentEvidence] WORLDBOOK_APPLY_DELIVERY_PENDING') });
  }
  WORLDBOOK_APPLY_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
let NPC_OPERATION_EVIDENCE_SCHEDULER = AGENT_EVIDENCE_LEDGER
  ? createNpcOperationEvidenceScheduler({ manager: maintenanceJobs, dataDir: DATA_DIR,
    ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
    onFailure: () => console.warn('[AgentEvidence] NPC_OPERATION_DELIVERY_PENDING') }) : null;
function scheduleNpcOperationEvidence(rawSessionId: string): void {
  if (shuttingDown || !sessionDeletionAdmissionOpen(rawSessionId)) return;
  if (!NPC_OPERATION_EVIDENCE_SCHEDULER) {
    if (!AGENT_EVIDENCE_LEDGER) {
      if (!hasRetainedNpcOperationEvidence(DATA_DIR, (id) => SESSION_DELETION_JOURNAL.isBlocked(id))
          || !sessionDeletionAdmissionOpen(rawSessionId)) return;
      AGENT_EVIDENCE_LEDGER = new AgentEvidenceLedger({ dataDir: DATA_DIR,
        isSessionDeleted: (id) => SESSION_DELETION_JOURNAL.isBlocked(id) });
    }
    NPC_OPERATION_EVIDENCE_SCHEDULER = createNpcOperationEvidenceScheduler({ manager: maintenanceJobs,
      dataDir: DATA_DIR, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
      onFailure: () => console.warn('[AgentEvidence] NPC_OPERATION_DELIVERY_PENDING') });
  }
  NPC_OPERATION_EVIDENCE_SCHEDULER.schedule(rawSessionId);
}
const MAINTENANCE_MEMORY_CONSUMPTION_SCHEDULER = AGENT_CLOSURE_STORE
  ? createMaintenanceMemoryConsumptionScheduler({
    manager: maintenanceJobs, closure: AGENT_CLOSURE_STORE, allowed: sessionDeletionAdmissionOpen,
    onDelivered: (id) => { scheduleReportedEffectEvidence(id); wakeEffectWatchRecovery(id); },
    open: (sessionId) => {
      if (!sessionDeletionAdmissionOpen(sessionId)) return null;
      const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
      return path ? openMaintenanceMemoryConsumptionRecovery(path, sessionId) : null;
    },
    onFailure: () => { AGENT_CLOSURE_DEGRADED = true; },
  }) : null;
const MAINTENANCE_SUMMARY_CONSUMPTION_SCHEDULER = AGENT_CLOSURE_STORE
  ? createMaintenanceSummaryConsumptionScheduler({
    manager: maintenanceJobs, closure: AGENT_CLOSURE_STORE, allowed: sessionDeletionAdmissionOpen,
    onDelivered: (id) => { scheduleReportedEffectEvidence(id); wakeEffectWatchRecovery(id); },
    open: (sessionId) => {
      if (!sessionDeletionAdmissionOpen(sessionId)) return null;
      const path = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
      return path ? openMaintenanceSummaryConsumptionRecovery(path, sessionId) : null;
    },
    onFailure: () => { AGENT_CLOSURE_DEGRADED = true; },
  }) : null;
const estimateMaintenanceCost = maintenanceCostEstimator(MAINTENANCE_RUNTIME);
let maintenanceHarness: MaintenanceHarnessService | undefined;
let maintenanceDrainPump: MaintenanceDrainPump | undefined;
let maintenanceAdmissionWarningEmitted = false;

const turnJobs = new TurnJobService({
  dataDir: DATA_DIR,
  serverInstanceId: SERVER_INSTANCE_ID,
  admissionOpen: releaseAdmissionOpen,
  sessionAdmissionOpen: sessionDeletionAdmissionOpen,
  resolveSession: (sessionId) => sessions.get(sessionId),
  loadSession: loadSessionById,
  beforeManagerClose: () => settleAgentLoopManagerReadersBeforeClose(),
  onProgress: ({ job, progress }) => eventHub.publish({ type: 'session.updated',
    resource: { kind: 'session', id: job.sessionId }, runId: job.runId, requestId: job.requestId,
    data: { status: `turn-${progress.phase}` } }),
  onJobEvent: ({ job, phase }) => {
    if (phase === 'queued' || phase === 'running') maintenanceHarness?.preemptSession(
      job.sessionId, MAINTENANCE_RUNTIME.enabled || STYLE_COMPILE_RUNTIME_CONFIG.enabled,
    );
    // Metadata only: the bounded observer catches asynchronous failures itself.
    // Legacy execution never awaits a Coordinator or grants it Provider rights.
    AGENT_LOOP_RUNTIME.observeTurnJobPhase({ runId: job.runId, phase });
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
    if (MAINTENANCE_RUNTIME.enabled || STYLE_COMPILE_RUNTIME_CONFIG.enabled) {
      maintenanceHarness?.markPostTurnSettled(job.sessionId);
    }
    STYLE_COMPILE_RUNTIME?.wakeSession(job.sessionId);
    // A regenerate rollback commits before its replacement Provider call, including failed/cancelled replacements.
    if (job.action === 'regenerate' || job.status === 'succeeded') {
      try { scheduleVariableInvalidationEvidence(job.sessionId); }
      catch { console.warn('[AgentEvidence] VARIABLE_INVALIDATION_DELIVERY_PENDING'); }
    }
    if (job.status === 'succeeded') EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER?.schedule(job.sessionId);
    if (job.status === 'succeeded') CLOSURE_SKILL_EVIDENCE_SCHEDULER?.schedule(job.sessionId);
    if (job.status === 'succeeded') MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.schedule(job.sessionId);
    if (job.status === 'succeeded') MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.schedule(job.sessionId);
    if (job.status === 'succeeded') {
      try { scheduleRegenerationEvidence(job.sessionId); }
      catch { console.warn('[AgentEvidence] REGENERATION_DELIVERY_PENDING'); }
    }
    if (job.status === 'succeeded') {
      try { scheduleBranchModifiedEvidence(job.sessionId); }
      catch { console.warn('[AgentEvidence] BRANCH_MODIFIED_DELIVERY_PENDING'); }
    }
    if (job.status === 'succeeded') {
      try { scheduleStyleCompileAdoptionEvidence(job.sessionId); }
      catch { console.warn('[AgentEvidence] STYLE_ADOPTION_DELIVERY_PENDING'); }
      try { scheduleVariableApplyEvidence(job.sessionId); }
      catch { console.warn('[AgentEvidence] VARIABLE_APPLY_DELIVERY_PENDING'); }
      try { scheduleNsfwSceneEvidence(job.sessionId); }
      catch { console.warn('[AgentEvidence] SCENE_CONSUMPTION_DELIVERY_PENDING'); }
    }
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
              const admissionNowMs = Date.now();
              const admissionJobs = [
                ...maintenanceJobs.list(job.sessionId, 100),
                ...maintenanceJobs.listAdmissionBudgetWindow(job.sessionId, admissionNowMs),
              ];
              const existingJobs = [...new Map(
                admissionJobs.map((entry) => [entry.runId, entry]),
              ).values()];
              const relevantParentRunIds = [...new Set(existingJobs.flatMap((entry) => (
                entry.parentRunId ? [entry.parentRunId] : []
              )))];
              const audits = buildMaintenanceAdmissionAudits({
                parentRunId: job.runId,
                sessionId: job.sessionId,
                sourceRevision: revision,
                observation: evidence.observation,
                domainEvidence: evidence.domainEvidence,
                foregroundActive: turnJobs.getActiveForSession(job.sessionId) !== null,
                existingJobs,
                priorAdmissions: AGENT_ADMISSION_LEDGER.listMaintenanceForParentRuns(
                  job.sessionId,
                  relevantParentRunIds,
                ),
                nowMs: admissionNowMs,
                sessionBudgetLimit: MAINTENANCE_ADMISSION_RUNTIME.sessionBudgetLimit,
                dailyBudgetLimit: MAINTENANCE_ADMISSION_RUNTIME.dailyBudgetLimit,
              });
              AGENT_ADMISSION_LEDGER.recordMaintenanceBatch(audits);
              // The audit batch is now durable. Notify the current session even
              // when policy, budget, cooldown, or the foreground style slot
              // leaves no task to enqueue; REST remains the authoritative view.
              publishMaintenanceLifecycleInvalidation(eventHub, {
                phase: 'evaluated',
                job: { sessionId: job.sessionId, runId: job.runId },
              });
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
            maintenanceDrainPump?.request();
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
type MaintenanceHostJob = Parameters<MaintenanceHarnessServiceOptions['modelFor']>[0];
type MaintenanceHostBinding = Parameters<MaintenanceHarnessServiceOptions['modelFor']>[1];

/** Public metadata only: budget preview must not allocate another transport before Session load. */
function readMaintenanceModelProfile(job: MaintenanceHostJob, singleCall = false) {
  if (!PROVIDER_SPI_ENABLED) throw new Error('agent-provider-registry-disabled');
  const selection = resolveAgentSelection(), descriptor = providerRegistry.describe(selection.providerId);
  if (!descriptor?.configured || !descriptor.capabilities.chatCompletions || !descriptor.capabilities.tools) {
    throw new Error('maintenance-model-host-unavailable');
  }
  const runtimeProfile = resolveModelRuntimeProfile({ providerId: selection.providerId, modelId: selection.model,
    supportsTools: descriptor.capabilities.tools, supportsStreaming: descriptor.capabilities.stream });
  const fullBudget = maintenanceBudgetProfileForAutonomy('quality-beta', job.taskKind, process.env, runtimeProfile);
  const budgetProfile = singleCall ? normalizeAgentBudgetProfile({ ...fullBudget, maxModelCalls: 1 }) : fullBudget;
  return { providerId: selection.providerId, modelId: selection.model, runtimeProfile, budgetProfile };
}

/** Real live environment only, not a source/dispatch/write grant. The ordinary
 * Model reader below still requires its original source revision. */
function readMaintenanceLiveModelHostEnvironment(job: MaintenanceHostJob, singleCall = false): MaintenanceModelHostEnvironment | null {
  try {
    if (!agentLoopManagerReadersReady || !PROVIDER_SPI_ENABLED || !releaseAdmissionOpen()
      || !sessionDeletionAdmissionOpen(job.sessionId) || !maintenanceTaskExecutionAllowed(job.sessionId, job.taskKind)
      || !maintenanceJobs.settings(job.sessionId).effectiveEnabled
      || !maintenanceModelModeAllowed(MAINTENANCE_RUNTIME.enabled, MAINTENANCE_APPLY_RUNTIME, job)
      || turnJobs.getActiveForSession(job.sessionId) !== null || !AGENT_ADMISSION_LEDGER) return null;
    // Recheck this after every awaited preparation too: AL cannot acquire a legacy Skill proof lifecycle.
    if (singleCall && ((job.taskKind === 'rolling_summary' && maintenanceSummarySkillLiveEnabled(process.env)
      && maintenanceSummarySkillPolicyAllowed(job.policyVersion))
      || (job.taskKind === 'memory_consolidation' && maintenanceMemorySkillLiveEnabled(process.env)
        && maintenanceMemorySkillPolicyAllowed(job.policyVersion)))) return null;
    const execution = maintenanceJobs.readExecution(job.runId), session = sessions.get(job.sessionId);
    if (!execution || !session || execution.executorRoute !== (singleCall ? 'agent-loop' : 'legacy')) return null;
    const audit = AGENT_ADMISSION_LEDGER.listMaintenance({ parentRunId: job.parentRunId, sessionId: job.sessionId, limit: 32 })
      .find((entry) => entry.sourceRevision === job.sourceRevision && entry.facts.taskKind === job.taskKind
        && entry.decision.policyVersion === job.policyVersion && entry.decision.verdict === 'would-admit');
    if (!audit) return null;
    const sourceRevision = snapshotForSession(session).snapshotToken;
    const profile = readMaintenanceModelProfile(job, singleCall);
    if (sessions.get(job.sessionId) !== session || !sessionDeletionAdmissionOpen(job.sessionId)
      || snapshotForSession(session).snapshotToken !== sourceRevision) return null;
    return { execution, sessionIdentity: session, sourceRevision, contentMode: session.getContentMode(),
      ...profile };
  } catch { return null; }
}

/** Synchronous original-source authority readback. No new dispatch may borrow
 * a post-write live claim to replace its captured source. */
function readMaintenanceModelHostEnvironment(job: MaintenanceHostJob, singleCall = false): MaintenanceModelHostEnvironment | null {
  const current = readMaintenanceLiveModelHostEnvironment(job, singleCall);
  return current?.sourceRevision === job.sourceRevision ? current : null;
}

/** One existing admitted model factory; no second execution route or Client. */
function createMaintenanceHostModel(job: MaintenanceHostJob, binding: MaintenanceHostBinding,
  agentLoop?: Readonly<{ assertCurrent: () => void; assertDispatch: () => void;
    ceilingBudgetProfile: MaintenanceHostBinding['budgetProfile']; admissionScope: AgentLoopModelAdmissionScope }>) {
    if (!maintenanceModelModeAllowed(MAINTENANCE_RUNTIME.enabled, MAINTENANCE_APPLY_RUNTIME, job)) {
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
    if (!PROVIDER_SPI_ENABLED) throw new Error('agent-provider-registry-disabled');
    // Validate the actual claim, loaded Session and current profile before constructing a Client.
    const sourceGuard = createMaintenanceModelHostGuard({ job, execution: binding.execution,
      verifiedSourceRevision: binding.verifiedSourceRevision, budgetProfile: binding.budgetProfile,
      expectedExecutorRoute: agentLoop ? 'agent-loop' : 'legacy',
      readCurrent: () => {
        const current = readMaintenanceModelHostEnvironment(job, agentLoop !== undefined);
        if (!current || !agentLoop) return current;
        if (agentBudgetProfileDigest(current.budgetProfile) !== agentBudgetProfileDigest(agentLoop.ceilingBudgetProfile)) return null;
        return { ...current, budgetProfile: binding.budgetProfile };
      },
      clock: () => new Date().toISOString() });
    const fixed = sourceGuard.fixed;
    const session = sessions.get(job.sessionId);
    if (!session || sourceGuard.assertCurrent().sessionIdentity !== session) throw new Error('maintenance-session-not-loaded');
    const memorySkillEligible = maintenanceMemorySkillLiveEnabled(process.env)
      && job.taskKind === 'memory_consolidation' && maintenanceMemorySkillPolicyAllowed(job.policyVersion);
    const summarySkillEligible = maintenanceSummarySkillLiveEnabled(process.env)
      && job.taskKind === 'rolling_summary' && maintenanceSummarySkillPolicyAllowed(job.policyVersion);
    const arcSkillEligible = maintenanceArcSkillLiveEnabled(process.env) && job.taskKind === 'branch_index';
    if (arcSkillEligible && !maintenanceArcSkillPolicyAllowed(job.policyVersion)) {
      throw new Error('maintenance-arc-skill-policy-unsupported');
    }
    const npcSkillEligible = maintenanceNpcSkillLiveEnabled(process.env) && job.taskKind === 'npc_state';
    if (npcSkillEligible && !maintenanceNpcSkillPolicyAllowed(job.policyVersion)) {
      throw new Error('maintenance-npc-skill-policy-unsupported');
    }
    const worldbookSkillEligible = maintenanceWorldbookSkillLiveEnabled(process.env) && job.taskKind === 'worldbook_repair';
    if (worldbookSkillEligible && !maintenanceWorldbookSkillPolicyAllowed(job.policyVersion)) {
      throw new Error('maintenance-worldbook-skill-policy-unsupported');
    }
    if (worldbookSkillEligible && (!WORLDBOOK_REPAIR_CONTROL_PLANE || !WORLDBOOK_REPAIR_CONTROL
      || !worldbookRepairForwardAllowsSession(WORLDBOOK_REPAIR_RUNTIME, job.sessionId))) {
      throw new Error('maintenance-worldbook-skill-registration-unavailable');
    }
    const requiredSkillEligible = arcSkillEligible || npcSkillEligible || worldbookSkillEligible;
    // AL has no HarnessResult/proposal-provenance lifecycle yet. Do not silently bypass a live Skill.
    if (agentLoop && (memorySkillEligible || summarySkillEligible || requiredSkillEligible)) throw new Error('agent-loop-maintenance-skill-lifecycle-unbound');
    agentLoop?.assertCurrent();
    const { selection: cfg, client: rawObserved } = agentModelBinding({ providerId: fixed.providerId, model: fixed.modelId });
    const actualRuntime = modelRuntimeProfileFor(cfg, rawObserved);
    const actualFullBudget = maintenanceBudgetProfileForAutonomy('quality-beta', job.taskKind, process.env, actualRuntime);
    const actualCeiling = agentLoop ? normalizeAgentBudgetProfile({ ...actualFullBudget, maxModelCalls: 1 }) : actualFullBudget;
    if (agentLoop && agentBudgetProfileDigest(actualCeiling) !== agentBudgetProfileDigest(agentLoop.ceilingBudgetProfile)) {
      throw new Error('maintenance-model-host-profile-changed');
    }
    const actualBudget = agentLoop ? assertAgentBudgetWithinHostCeiling(actualCeiling, binding.budgetProfile) : actualCeiling;
    if (modelRuntimeProfileDigest(actualRuntime) !== fixed.runtimeProfileDigest
      || agentBudgetProfileDigest(actualBudget) !== agentBudgetProfileDigest(binding.budgetProfile)) {
      throw new Error('maintenance-model-host-profile-changed');
    }
    // P17-01.3：维护入口接全局仲裁（background 类）。provider 身份取自本次绑定，
    // 不在 adapter 里猜；被前台抢占后迟到的结果会抛错而不是写入。
    let physicalLease: AgentAdmissionLease | undefined;
    const observed = arbitratedAgentClient(rawObserved, cfg, 'maintenance', undefined, () => {
      // Arbitration may have waited after the Gateway guard. There is no await
      // between this final check and the existing Observed/Registry handoff.
      const lease = physicalLease;
      if (!lease || !AGENT_ADMISSION_BROKER.mayDispatchLease(lease) || !authorizeHostDispatch(lease)) {
        throw new AdmittedModelGatewayError('gateway-dispatch-authority-denied');
      }
    });
    let skillHost: ReturnType<typeof createMaintenanceMemorySkillHostAuthority>
      | ReturnType<typeof createMaintenanceSummarySkillHostAuthority>
      | ReturnType<typeof createMaintenanceArcSkillHostAuthority>
      | ReturnType<typeof createMaintenanceNpcSkillHostAuthority>
      | ReturnType<typeof createMaintenanceWorldbookSkillHostAuthority> | null = null;
    let memoryCall: ReturnType<typeof createMaintenanceMemorySkillLiveCall> | null = null;
    let summaryCall: ReturnType<typeof createMaintenanceSummarySkillLiveCall> | null = null;
    let arcCall: ReturnType<typeof createMaintenanceArcSkillLiveCall> | null = null;
    let npcCall: ReturnType<typeof createMaintenanceNpcSkillLiveCall> | null = null;
    let worldbookCall: ReturnType<typeof createMaintenanceWorldbookSkillLiveCall> | null = null;
    if (arcSkillEligible && !binding.proposalContext) throw new Error('maintenance-arc-skill-context-required');
    if (npcSkillEligible && !binding.proposalContext) throw new Error('maintenance-npc-skill-context-required');
    if (worldbookSkillEligible && !binding.proposalContext) throw new Error('maintenance-worldbook-skill-context-required');
    if ((memorySkillEligible || summarySkillEligible || requiredSkillEligible) && binding.proposalContext) {
      try {
        const ports: Omit<Parameters<typeof createMaintenanceMemorySkillHostAuthority>[0],
          'source' | 'sourceAuthority' | 'liveEnabled'> = { execution: binding.execution,
          jobAuthority: maintenanceJobs, controlStore: AGENT_CONTROL_STORE,
          isSessionOpen: () => sessionDeletionAdmissionOpen(job.sessionId) && sessions.get(job.sessionId) === session,
          readLaneRuntime: () => parseAgentLaneRuntimeConfig(process.env),
          readEligibility: (lease) => {
            const budget = maintenanceBudgetProfileForAutonomy('quality-beta', job.taskKind, process.env,
              modelRuntimeProfileFor(cfg, observed));
            const revision = agentBudgetProfileDigest(budget);
            return { revision, allowed: maintenanceAdmissionAllowsSession(MAINTENANCE_ADMISSION_RUNTIME, job.sessionId)
              && maintenanceJobs.settings(job.sessionId).effectiveEnabled
              && maintenanceModelModeAllowed(MAINTENANCE_RUNTIME.enabled, MAINTENANCE_APPLY_RUNTIME, job)
              && (!worldbookSkillEligible || !!(WORLDBOOK_REPAIR_CONTROL_PLANE && WORLDBOOK_REPAIR_CONTROL
                && worldbookRepairForwardAllowsSession(WORLDBOOK_REPAIR_RUNTIME, job.sessionId)))
              && turnJobs.getActiveForSession(job.sessionId) === null && revision === lease.budgetProfileDigest };
          },
          safetyAuthority: { readForLease: (lease, current) => {
            const dbPath = resolveSessionDatabase(DATA_DIR, `${job.sessionId}.db`);
            return dbPath ? { sessionId: lease.sessionId, sourceRevision: current.sourceRevision,
              state: NSFW_SCENE_SAFETY_CONTROL.read({ dbPath, sessionId: job.sessionId,
                manifest: session.getWorldbookSourceManifest() }) } : null;
          } },
        };
        const fixedSource = { sessionId: job.sessionId, contentMode: session.getContentMode(),
          assets: session.readAgentSkillAssetContext(), snapshot: binding.snapshot };
        const readCurrentSource = () => {
            const revision = snapshotForSession(session).snapshotToken;
            if (revision !== job.sourceRevision) return null;
            const summaryState = job.taskKind === 'rolling_summary' ? session.getMemory().mem.db.prepare(
              `SELECT COALESCE(longterm,'') longterm,COALESCE(summary_round,0) summaryRound
               FROM memory_meta WHERE id=1`,
            ).get() as { longterm: string; summaryRound: number } | undefined : undefined;
            const providerInput = { maxTokens: binding.budgetProfile.agentInputBudgetTokens,
              system: maintenanceSystemPrompt(job.taskKind) };
            const snapshot = job.taskKind === 'branch_index'
              ? buildBranchIndexSnapshotForSession(session, job.sessionId, revision, providerInput)
              : buildMaintenanceSessionSnapshot({ session, sessionId: job.sessionId, revision,
              taskKind: job.taskKind, worldbookEntries: maintenanceWorldbookEntries(session),
              ...(summaryState ? { summaryState } : {}),
              ...(job.taskKind === 'worldbook_repair' ? {
                worldbookRepairContext: maintenanceWorldbookRepairContext(session, job.sessionId, worldbookSkillEligible),
              } : {}),
              providerInputBudget: providerInput });
            const current = { sessionId: job.sessionId, contentMode: session.getContentMode(),
              assets: session.readAgentSkillAssetContext(), snapshot };
            return snapshotForSession(session).snapshotToken === revision ? current : null;
        };
        if (memorySkillEligible) {
          skillHost = createMaintenanceMemorySkillHostAuthority({ ...ports,
            source: captureMaintenanceMemorySkillSource(fixedSource),
            liveEnabled: () => maintenanceMemorySkillLiveEnabled(process.env),
            sourceAuthority: { readCurrent: () => {
              const current = readCurrentSource();
              return current ? captureMaintenanceMemorySkillSource(current) : null;
            } },
          });
          memoryCall = createMaintenanceMemorySkillLiveCall({ broker: AGENT_ADMISSION_BROKER,
            authority: skillHost.authority, proposalContext: binding.proposalContext });
        } else if (summarySkillEligible) {
          skillHost = createMaintenanceSummarySkillHostAuthority({ ...ports,
            source: captureMaintenanceSummarySkillSource(fixedSource),
            liveEnabled: () => maintenanceSummarySkillLiveEnabled(process.env),
            sourceAuthority: { readCurrent: () => {
              const current = readCurrentSource();
              return current ? captureMaintenanceSummarySkillSource(current) : null;
            } },
          });
          summaryCall = createMaintenanceSummarySkillLiveCall({ broker: AGENT_ADMISSION_BROKER,
            authority: skillHost.authority, proposalContext: binding.proposalContext });
        } else if (arcSkillEligible) {
          skillHost = createMaintenanceArcSkillHostAuthority({ ...ports,
            source: captureMaintenanceArcSkillSource(fixedSource),
            liveEnabled: () => maintenanceArcSkillLiveEnabled(process.env),
            sourceAuthority: { readCurrent: () => {
              const current = readCurrentSource();
              return current ? captureMaintenanceArcSkillSource(current) : null;
            } },
          });
          arcCall = createMaintenanceArcSkillLiveCall({ broker: AGENT_ADMISSION_BROKER,
            authority: skillHost.authority, proposalContext: binding.proposalContext });
        } else if (npcSkillEligible) {
          skillHost = createMaintenanceNpcSkillHostAuthority({ ...ports,
            source: captureMaintenanceNpcSkillSource(fixedSource),
            liveEnabled: () => maintenanceNpcSkillLiveEnabled(process.env),
            sourceAuthority: { readCurrent: () => {
              const current = readCurrentSource();
              return current ? captureMaintenanceNpcSkillSource(current) : null;
            } },
          });
          npcCall = createMaintenanceNpcSkillLiveCall({ broker: AGENT_ADMISSION_BROKER,
            authority: skillHost.authority, proposalContext: binding.proposalContext });
        } else {
          skillHost = createMaintenanceWorldbookSkillHostAuthority({ ...ports,
            source: captureMaintenanceWorldbookSkillSource(fixedSource),
            liveEnabled: () => maintenanceWorldbookSkillLiveEnabled(process.env),
            sourceAuthority: { readCurrent: () => {
              const current = readCurrentSource();
              return current ? captureMaintenanceWorldbookSkillSource(current) : null;
            } },
          });
          worldbookCall = createMaintenanceWorldbookSkillLiveCall({ broker: AGENT_ADMISSION_BROKER,
            authority: skillHost.authority, proposalContext: binding.proposalContext });
        }
      } catch (error) {
        if (requiredSkillEligible) throw error;
        // Memory/Summary retain their existing optional provenance contract.
      }
    }
    if (arcSkillEligible && !arcCall) throw new Error('maintenance-arc-skill-call-required');
    if (npcSkillEligible && !npcCall) throw new Error('maintenance-npc-skill-call-required');
    if (worldbookSkillEligible && !worldbookCall) throw new Error('maintenance-worldbook-skill-call-required');
    const skillCall = worldbookCall ?? npcCall ?? arcCall ?? memoryCall ?? summaryCall;
    let pendingSkillAudit: AdmittedModelLeaseAudit | undefined;
    let skillAuditSettled = false;
    const authorizeHostDispatch = (lease: AgentAdmissionLease): boolean => {
      if (!sourceGuard.authorizeDispatch(lease)) return false;
      try { agentLoop?.assertDispatch(); } catch { return false; }
      return !skillHost || skillHost.authorizeDispatch(lease);
    };
    const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER, observed, {
      estimateCostMicrousd: (usage) => estimateMaintenanceCost({
        model: cfg.model,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
      }),
      onLeaseClosed: (entry) => {
        if (!requiredSkillEligible) { recordAgentRuntimeLease(entry); return; }
        // Gateway closes immediately on the final allowed call. Preserve its audit until
        // the live request and proposal have been sealed, before any durable success.
        if (pendingSkillAudit || skillAuditSettled) throw new AdmittedModelGatewayError('gateway-lease-audit-failed');
        pendingSkillAudit = entry;
      },
      auditRequired: true,
      prepareRequest: skillCall?.prepareRequest ?? (async () => null),
      ...(requiredSkillEligible ? { prepareRequestRequired: true } : {}),
      authorizeDispatch: (lease) => {
        if (!authorizeHostDispatch(lease)) return false;
        physicalLease = lease;
        return true;
      },
    });
    const admitted = createAdmittedMaintenanceModel({
      broker: AGENT_ADMISSION_BROKER,
      gateway,
      job,
      verifiedSourceRevision: binding.verifiedSourceRevision,
      proposalContext: binding.proposalContext,
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
      nowMs: Date.now,
      ...(agentLoop ? { agentLoopInvocation: agentLoop.admissionScope } : {}),
    });
    const requiredSkillAdmitted = requiredSkillEligible ? { ...admitted,
      finish(outcome: Parameters<typeof admitted.finish>[0] = 'completed') {
        try { admitted.finish(outcome); }
        finally {
          if (pendingSkillAudit) {
            const entry = pendingSkillAudit;
            pendingSkillAudit = undefined;
            skillAuditSettled = true;
            try { recordAgentRuntimeLease(entry); }
            catch { throw new AdmittedModelGatewayError('gateway-lease-audit-failed'); }
          }
        }
      },
    } : admitted;
    const handle = worldbookCall ? bindMaintenanceWorldbookSkillLifecycle(requiredSkillAdmitted, worldbookCall)
      : npcCall ? bindMaintenanceNpcSkillLifecycle(requiredSkillAdmitted, npcCall)
      : arcCall ? bindMaintenanceArcSkillLifecycle(requiredSkillAdmitted, arcCall)
      : summaryCall ? bindMaintenanceSummarySkillLifecycle(admitted, summaryCall)
      : memoryCall ? bindMaintenanceMemorySkillLifecycle(admitted, memoryCall) : admitted;
    return Object.freeze({ handle, sourceGuard });
}

/** Isolated correction MODEL host seam. Not installed in production composition.
 * Only the original Runtime supplies the live lifetime and Service context. The
 * initial grant/policy is committed before constructing the original MODEL port;
 * no Action, completion, alternate Coordinator or Provider factory is introduced.
 */
async function createAgentLoopMaintenanceHostCorrection(context: MaintenanceAgentLoopExecutionContext,
  step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0], lifetime: Readonly<{
    assertActive: () => void;
    onPrepared: (result: Awaited<ReturnType<ReturnType<typeof createAgentLoopMaintenanceCorrectionPrepare>['prepare']>>) => void;
  }>): Promise<ReturnType<typeof createAgentLoopMaintenanceCorrectionModel>> {
  const { ownerId, signal, clock, readCurrent } = createAgentLoopMaintenanceCorrectionHostSource(context, step, lifetime);
  const prepared = await createAgentLoopMaintenanceCorrectionPrepare({ store: AGENT_LOOP_PROJECTION_STORE,
    ownerId, clock, signal, readCurrent, onPrepared: lifetime.onPrepared }).prepare({ taskId: context.taskId, revision: step.revision });
  lifetime.assertActive();
  return createAgentLoopMaintenanceCorrectionModel({ store: AGENT_LOOP_PROJECTION_STORE, ownerId, clock, signal,
    policy: prepared.policy, readCurrent,
    createHandle(input) {
      lifetime.assertActive();
      return createMaintenanceHostModel(input.execution.job, { execution: input.execution, snapshot: input.source.snapshot,
        verifiedSourceRevision: input.source.snapshot.revision, budgetProfile: input.callBudgetProfile,
        proposalContext: input.source.snapshot.providerProposalContext ?? input.source.snapshot.proposalContext }, {
        ceilingBudgetProfile: normalizeAgentBudgetProfile(input.source.profile.budgetProfile), admissionScope: input.admissionScope,
        assertCurrent: input.assertCurrent, assertDispatch: input.assertDispatch,
      }).handle;
    } });
}

/** Same original source/Session capture for the two closed correction hosts.
 * It is AL-read-free: the callbacks also run inside Store writer transactions. */
function createAgentLoopMaintenanceCorrectionHostSource(context: MaintenanceAgentLoopExecutionContext,
  step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0], lifetime: Readonly<{
    assertActive: () => void;
    onPrepared: (result: Awaited<ReturnType<ReturnType<typeof createAgentLoopMaintenanceCorrectionPrepare>['prepare']>>) => void;
  }>) {
  if (!agentLoopLegacySourceReady || !context || !context.signal || context.signal.aborted
    || !lifetime || typeof lifetime.assertActive !== 'function' || typeof lifetime.onPrepared !== 'function'
    || step.envelope.taskId !== context.taskId || step.revision !== 1) throw new Error('agent-loop-maintenance-host-unavailable');
  lifetime.assertActive();
  const { ownerId, signal } = context, execution = maintenanceJobs.readExecution(context.execution.job.runId);
  if (!execution || execution.executorRoute !== 'agent-loop' || execution.leaseOwnerInstanceId !== ownerId
    || execution.job.taskKind !== 'rolling_summary' || execution.job.mode !== 'shadow'
    || !sameMaintenanceAgentLoopClaim(context.execution, execution)) throw new Error('agent-loop-maintenance-host-unavailable');
  const job = execution.job, environment = readMaintenanceModelHostEnvironment(job, true), session = sessions.get(job.sessionId);
  if (!environment || !session || environment.sessionIdentity !== session) throw new Error('agent-loop-maintenance-host-unavailable');
  const clock = () => new Date().toISOString();
  const guard = createMaintenanceModelHostGuard({ job, execution, verifiedSourceRevision: job.sourceRevision,
    budgetProfile: environment.budgetProfile, expectedExecutorRoute: 'agent-loop',
    readCurrent: () => readMaintenanceModelHostEnvironment(job, true), clock });
  let expectedBinding: string | undefined;
  // Source-only: lifetime.assertActive must not access AL storage because this
  // read port also runs under the original Store's writer transaction.
  const readCurrent = () => {
    lifetime.assertActive();
    if (signal.aborted || sessions.get(job.sessionId) !== session) throw new Error('agent-loop-maintenance-host-unavailable');
    const current = guard.assertCurrent();
    if (current.sessionIdentity !== session) throw new Error('agent-loop-maintenance-host-unavailable');
    const snapshot = buildRollingSummarySnapshotForSession(session, job.sessionId, current.sourceRevision, {
      maxTokens: guard.fixed.budgetProfile.agentInputBudgetTokens, system: maintenanceSystemPrompt('rolling_summary'),
    });
    const latest = guard.assertCurrent();
    if (sessions.get(job.sessionId) !== session || latest.sessionIdentity !== session) throw new Error('agent-loop-maintenance-host-unavailable');
    const result = { execution: latest.execution, source: { job: latest.execution.job, snapshot,
      profile: { providerId: latest.providerId, modelId: latest.modelId, runtimeProfile: latest.runtimeProfile,
        budgetProfile: latest.budgetProfile, policyVersion: job.policyVersion, contentMode: latest.contentMode },
      sessionIdentity: session, hostDispatchGuarded: true as const } };
    const binding = agentLoopMaintenanceBindingRef(result.execution, result.source);
    if (expectedBinding !== undefined && binding !== expectedBinding) throw new Error('agent-loop-maintenance-host-unavailable');
    lifetime.assertActive();
    return result;
  };
  const first = readCurrent(); expectedBinding = agentLoopMaintenanceBindingRef(first.execution, first.source);
  return { ownerId, signal, clock, readCurrent };
}

/** Installed only through the lazy versioned Runtime profile; there is still
 * no production dispatcher/claim authority. Prepare owns the original source
 * closure; Runtime consumes the live cap and calls createAction before Core
 * writes its Action-started watermark. */
async function createAgentLoopMaintenanceHostCorrectionProposal(context: MaintenanceAgentLoopExecutionContext,
  step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0], lifetime: Readonly<{
    assertActive: () => void;
    onPrepared: (result: Awaited<ReturnType<ReturnType<typeof createAgentLoopMaintenanceCorrectionPrepare>['prepare']>>) => void;
  }>) {
  const { ownerId, signal, clock, readCurrent } = createAgentLoopMaintenanceCorrectionHostSource(context, step, lifetime);
  const prepared = await createAgentLoopMaintenanceCorrectionProposalPrepare({ store: AGENT_LOOP_PROJECTION_STORE,
    ownerId, clock, signal, readCurrent, onPrepared: lifetime.onPrepared }).prepare({ taskId: context.taskId, revision: step.revision });
  try {
    lifetime.assertActive();
    const model = createAgentLoopMaintenanceCorrectionProposalModel({ store: AGENT_LOOP_PROJECTION_STORE,
      ownerId, clock, signal, policy: prepared.policy, proposalCapability: prepared.proposalCapability, readCurrent,
      createHandle(input) {
        lifetime.assertActive();
        return createMaintenanceHostModel(input.execution.job, { execution: input.execution, snapshot: input.source.snapshot,
          verifiedSourceRevision: input.source.snapshot.revision, budgetProfile: input.callBudgetProfile,
          proposalContext: input.source.snapshot.providerProposalContext ?? input.source.snapshot.proposalContext }, {
          ceilingBudgetProfile: normalizeAgentBudgetProfile(input.source.profile.budgetProfile), admissionScope: input.admissionScope,
          assertCurrent: input.assertCurrent, assertDispatch: input.assertDispatch,
        }).handle;
      } });
    const publication = (input: Pick<AgentLoopCorrectionRollingSummaryArtifactSourceOptions,
        'observeRecord' | 'policy' | 'modelRecord' | 'modelOutcome' | 'actionRecord' | 'actionOutcome' | 'rejectedModelOutcome'>) => {
        const fields = normalizeAgentLoopActionObject(input,
          ['observeRecord','policy','modelRecord','modelOutcome','actionRecord','actionOutcome'],['rejectedModelOutcome']);
        lifetime.assertActive();
        const readSource = () => {
          const current = readCurrent();
          // hostDispatchGuarded belongs to the MODEL guard, not the original
          // artifact source's exact four-field source representation.
          return { execution: current.execution, source: { job: current.source.job, profile: current.source.profile,
            snapshot: current.source.snapshot, sessionIdentity: current.source.sessionIdentity } };
        };
        const current = readSource();
        return createAgentLoopCorrectionShadowPublication({ store: AGENT_LOOP_PROJECTION_STORE, manager: maintenanceJobs,
          ownerId, clock, signal, execution: current.execution, fixedSource: current.source, readCurrent: readSource,
          observeRecord: fields.observeRecord as typeof input.observeRecord, policy: fields.policy as typeof input.policy,
          modelRecord: fields.modelRecord as typeof input.modelRecord, modelOutcome: fields.modelOutcome,
          actionRecord: fields.actionRecord as typeof input.actionRecord, actionOutcome: fields.actionOutcome,
          ...(Object.hasOwn(fields,'rejectedModelOutcome') ? { rejectedModelOutcome: fields.rejectedModelOutcome } : {}) });
      };
    return Object.freeze({ ...model, proposalCapability: prepared.proposalCapability, publication,
      createAction(input: Pick<AgentLoopMaintenanceCorrectionProposalActionOptions,
        'record' | 'policy' | 'modelRecord' | 'modelOutcome' | 'decision' | 'rejectedModelOutcome'>) {
        const fields = normalizeAgentLoopActionObject(input, ['record','policy','modelRecord','modelOutcome','decision'], ['rejectedModelOutcome']);
        lifetime.assertActive();
        const current = readCurrent();
        return createAgentLoopMaintenanceCorrectionProposalAction({ store: AGENT_LOOP_PROJECTION_STORE, manager: maintenanceJobs,
          ownerId, clock, signal, execution: current.execution, fixedSource: current.source, readCurrent,
          record: fields.record as typeof input.record, policy: fields.policy as typeof input.policy,
          modelRecord: fields.modelRecord as typeof input.modelRecord, modelOutcome: fields.modelOutcome as typeof input.modelOutcome,
          decision: fields.decision, ...(Object.hasOwn(fields,'rejectedModelOutcome')
            ? { rejectedModelOutcome: fields.rejectedModelOutcome as typeof input.rejectedModelOutcome } : {}) });
      } });
  } catch (error) {
    // COMMIT facts are durable. This is only the live cap's ownership cleanup
    // when construction failed before Runtime could receive its revoke owner.
    revokeAgentLoopCorrectionProposalCapability(prepared.proposalCapability);
    throw error;
  }
}

/** Initial trusted Prepare seam only; the production runtime remains fixed-deny.
 * Caller must first obtain an explicit durable AL claim. No Client or Ticket is allocated here.
 */
function createAgentLoopMaintenanceHostPrepare(input: Readonly<{
  runId: string; taskId: string; expectedRevision: number; ownerId: string; signal: AbortSignal;
}>) {
  if (!agentLoopLegacySourceReady || !input || !input.signal || input.signal.aborted) {
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
  const { runId, taskId, expectedRevision, ownerId, signal } = input;
  const execution = maintenanceJobs.readExecution(runId);
  if (!execution || execution.executorRoute !== 'agent-loop' || execution.leaseOwnerInstanceId !== ownerId
    || execution.job.taskKind !== 'rolling_summary') {
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
  const job = execution.job, environment = readMaintenanceModelHostEnvironment(job, true);
  if (!environment) throw new Error('agent-loop-maintenance-host-unavailable');
  const guard = createMaintenanceModelHostGuard({ job, execution, verifiedSourceRevision: job.sourceRevision,
    budgetProfile: environment.budgetProfile, expectedExecutorRoute: 'agent-loop',
    readCurrent: () => readMaintenanceModelHostEnvironment(job, true), clock: () => new Date().toISOString() });
  const clock = () => new Date().toISOString();
  const readCurrent = () => {
    if (signal.aborted) throw new Error('agent-loop-maintenance-host-unavailable');
    const current = guard.assertCurrent(), session = sessions.get(job.sessionId);
    if (!session || current.sessionIdentity !== session) throw new Error('agent-loop-maintenance-host-unavailable');
    const snapshot = buildRollingSummarySnapshotForSession(session, job.sessionId, current.sourceRevision, {
      maxTokens: guard.fixed.budgetProfile.agentInputBudgetTokens, system: maintenanceSystemPrompt('rolling_summary'),
    });
    const latest = guard.assertCurrent();
    return { execution: latest.execution, source: { job: latest.execution.job, snapshot,
      profile: { providerId: latest.providerId, modelId: latest.modelId, runtimeProfile: latest.runtimeProfile,
        budgetProfile: latest.budgetProfile, policyVersion: job.policyVersion, contentMode: latest.contentMode },
      sessionIdentity: session } };
  };
  const adapter = createAgentLoopMaintenanceExecutionPrepare({ store: AGENT_LOOP_PROJECTION_STORE, ownerId, clock, readCurrent });
  const assertStep = (step: Parameters<typeof adapter.prepare>[0]) => {
    if (step.envelope.taskId !== taskId || step.revision !== expectedRevision) throw new Error('agent-loop-maintenance-host-unavailable');
  };
  return Object.freeze({
    prepare: async (step: Parameters<typeof adapter.prepare>[0]) => {
      assertStep(step);
      return adapter.prepare(step);
    },
    prepareGetVariables: async (step: Parameters<typeof adapter.prepare>[0]) => {
      assertStep(step);
      const getVariablesAuthorization = issueAgentLoopGetVariablesAuthorization({ store: AGENT_LOOP_PROJECTION_STORE,
        ownerId, clock, signal, readCurrent });
      return createAgentLoopMaintenanceExecutionPrepare({ store: AGENT_LOOP_PROJECTION_STORE,
        ownerId, clock, readCurrent, getVariablesAuthorization }).prepare(step);
    },
    // A separate host seam only; the production composition does not select this route.
    prepareRollingSummaryProposal: async (step: Parameters<typeof adapter.prepare>[0]) => {
      assertStep(step);
      const rollingSummaryProposalAuthorization = issueAgentLoopRollingSummaryProposalAuthorization({ store: AGENT_LOOP_PROJECTION_STORE,
        ownerId, clock, signal, readCurrent });
      return createAgentLoopMaintenanceExecutionPrepare({ store: AGENT_LOOP_PROJECTION_STORE,
        ownerId, clock, readCurrent, rollingSummaryProposalAuthorization }).prepare(step);
    },
    // Separate host capability; only the trusted apply route selects it.
    // The production Service pre-claim gate stays closed.
    prepareRollingSummaryApply: async (step: Parameters<typeof adapter.prepare>[0], context?: MaintenanceAgentLoopExecutionContext) => {
      assertStep(step);
      assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, job.sessionId, 'rolling_summary');
      // Capture the original source BEFORE the source-changing native ACT.
      // The old three-step host seam may omit context and gains no completion.
      let completion: ReturnType<typeof createAgentLoopSummaryApplyCompletion> | undefined;
      if (context !== undefined) {
        AGENT_LOOP_APPLY_COMPLETION_HOSTS.delete(context);
        if (context.taskId !== taskId || context.ownerId !== ownerId || context.signal !== signal
          || !sameMaintenanceAgentLoopClaim(execution, context.execution)) throw new Error('agent-loop-maintenance-host-unavailable');
        const initial = readCurrent(), session = sessions.get(job.sessionId);
        if (!session || session !== initial.source.sessionIdentity) throw new Error('agent-loop-maintenance-host-unavailable');
        const liveGuard = createMaintenanceModelHostGuard({ job, execution: initial.execution,
          verifiedSourceRevision: job.sourceRevision, budgetProfile: guard.fixed.budgetProfile, expectedExecutorRoute: 'agent-loop',
          readCurrent: () => readMaintenanceLiveModelHostEnvironment(job, true), clock });
        const readLive = () => {
          if (signal.aborted || sessions.get(job.sessionId) !== session) throw new Error('agent-loop-maintenance-host-unavailable');
          assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, job.sessionId, 'rolling_summary');
          const current = liveGuard.assertLiveClaim();
          if (current.sessionIdentity !== session) throw new Error('agent-loop-maintenance-host-unavailable');
          assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, job.sessionId, 'rolling_summary');
          return current;
        };
        completion = createAgentLoopSummaryApplyCompletion({ store: AGENT_LOOP_PROJECTION_STORE, manager: maintenanceJobs,
          ownerId, clock, signal, execution: initial.execution, fixedSource: initial.source, readLive,
          committer: new MemorySummaryMaintenanceCommitter({ sessionId: job.sessionId, memory: session.getMemory().mem },
            (sessionId) => {
              if (sessionId !== job.sessionId || sessions.get(sessionId) !== session) throw new Error('agent-loop-maintenance-host-unavailable');
              return snapshotForSession(session).snapshotToken;
            }, clock) });
      }
      const rollingSummaryApplyAuthorization = issueAgentLoopRollingSummaryApplyAuthorization({ store: AGENT_LOOP_PROJECTION_STORE,
        ownerId, clock, signal, readCurrent });
      const prepared = await createAgentLoopMaintenanceExecutionPrepare({ store: AGENT_LOOP_PROJECTION_STORE,
        ownerId, clock, readCurrent, rollingSummaryApplyAuthorization }).prepare(step);
      if (context && completion && !signal.aborted) AGENT_LOOP_APPLY_COMPLETION_HOSTS.set(context, completion);
      return prepared;
    },
    // Read-only provenance/verifier adapter; does not itself request or complete a task.
    verification: () => {
      const initial = readCurrent();
      return createAgentLoopRollingSummaryProposalVerification({ store: AGENT_LOOP_PROJECTION_STORE,
        manager: maintenanceJobs, ownerId, clock, signal, execution: initial.execution,
        fixedSource: initial.source, readCurrent });
    },
    // Business-first completion seam. Only the original Service's trusted scope
    // can select it; production canClaim remains literally false.
    publication: () => {
      const initial = readCurrent();
      return createAgentLoopShadowPublication({ store: AGENT_LOOP_PROJECTION_STORE,
        manager: maintenanceJobs, ownerId, clock, signal, execution: initial.execution,
        fixedSource: initial.source, readCurrent });
    },
  });
}

/** One-use retrieval only. Original Prepare already captured the fixed source
 * and same loaded Session; the current post-write state cannot recreate it. */
function createAgentLoopMaintenanceHostApplyCompletion(context: MaintenanceAgentLoopExecutionContext,
  step: Readonly<{ envelope: import('@jiuguan/agent-loop-contract').AgentLoopTaskEnvelopeV1; revision: number }>) {
  const completion = AGENT_LOOP_APPLY_COMPLETION_HOSTS.get(context);
  AGENT_LOOP_APPLY_COMPLETION_HOSTS.delete(context);
  if (!completion || context.signal.aborted || !agentLoopLegacySourceReady) throw new Error('agent-loop-maintenance-host-unavailable');
  const record = AGENT_LOOP_PROJECTION_STORE.read(context.taskId);
  if (!record || record.ownerId !== context.ownerId || record.fenced || record.envelope.phase !== 'OBSERVE'
    || record.envelope.state !== 'RUNNING' || record.revision !== step.revision
    || JSON.stringify(record.envelope) !== JSON.stringify(step.envelope)) throw new Error('agent-loop-maintenance-host-unavailable');
  return completion;
}

/** One lazy fixed-snapshot read route, not a model Client or a second execution driver.
 * The runtime must supply its one-use trusted Action capability before entering this port.
 */
function createAgentLoopMaintenanceHostAction(input: Readonly<{
  runId: string; taskId: string; expectedRevision: number; ownerId: string; signal: AbortSignal;
}>) {
  if (!agentLoopLegacySourceReady || !input || !input.signal || input.signal.aborted) {
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
  const { runId, taskId, expectedRevision, ownerId, signal } = input;
  const execution = maintenanceJobs.readExecution(runId);
  if (!execution || execution.executorRoute !== 'agent-loop' || execution.leaseOwnerInstanceId !== ownerId
    || execution.job.taskKind !== 'rolling_summary') throw new Error('agent-loop-maintenance-host-unavailable');
  const job = execution.job, environment = readMaintenanceModelHostEnvironment(job, true);
  const record = AGENT_LOOP_PROJECTION_STORE.read(taskId);
  if (!environment || !record || record.revision !== expectedRevision || taskId !== `agentloop.maintenance.${runId}`) {
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
  const clock = () => new Date().toISOString();
  const guard = createMaintenanceModelHostGuard({ job, execution, verifiedSourceRevision: job.sourceRevision,
    budgetProfile: environment.budgetProfile, expectedExecutorRoute: 'agent-loop',
    readCurrent: () => readMaintenanceLiveModelHostEnvironment(job, true), clock });
  const readCurrent = () => {
    if (signal.aborted) throw new Error('agent-loop-maintenance-host-unavailable');
    const current = guard.assertCurrent(), session = sessions.get(job.sessionId);
    if (!session || current.sessionIdentity !== session) throw new Error('agent-loop-maintenance-host-unavailable');
    const snapshot = buildRollingSummarySnapshotForSession(session, job.sessionId, current.sourceRevision, {
      maxTokens: guard.fixed.budgetProfile.agentInputBudgetTokens, system: maintenanceSystemPrompt('rolling_summary'),
    });
    const latest = guard.assertCurrent();
    return { execution: latest.execution, source: { job: latest.execution.job, snapshot,
      profile: { providerId: latest.providerId, modelId: latest.modelId, runtimeProfile: latest.runtimeProfile,
        budgetProfile: latest.budgetProfile, policyVersion: job.policyVersion, contentMode: latest.contentMode },
      sessionIdentity: session } };
  };
  const initial = readCurrent();
  let readAdapter: ReturnType<typeof createAgentLoopMaintenanceGetVariablesAction> | undefined;
  let proposalAdapter: ReturnType<typeof createAgentLoopMaintenanceRollingSummaryProposalAction> | undefined;
  let applyAdapter: ReturnType<typeof createAgentLoopMaintenanceRollingSummaryApplyAction> | undefined;
  const assertStep = (step: Parameters<AgentLoopCoordinatorPorts['act']>[0]) => {
    if (step.actionRequest.taskId !== taskId || step.actionRequest.expectedTaskRevision !== expectedRevision) {
      throw new Error('agent-loop-maintenance-host-unavailable');
    }
  };
  return Object.freeze({
    act: async (step: Parameters<AgentLoopCoordinatorPorts['act']>[0]) => {
      assertStep(step);
      readAdapter ??= createAgentLoopMaintenanceGetVariablesAction({ store: AGENT_LOOP_PROJECTION_STORE,
        ownerId, clock, signal, execution: initial.execution, fixedSource: initial.source, readCurrent });
      return readAdapter.act(step);
    },
    actRollingSummaryProposal: async (step: Parameters<AgentLoopCoordinatorPorts['act']>[0]) => {
      assertStep(step);
      proposalAdapter ??= createAgentLoopMaintenanceRollingSummaryProposalAction({ store: AGENT_LOOP_PROJECTION_STORE,
        manager: maintenanceJobs, ownerId, clock, signal, execution: initial.execution,
        fixedSource: initial.source, readCurrent });
      return proposalAdapter.act(step);
    },
    // Trusted original-capability handoff only. Service.canClaim remains false;
    // no HTTP/ENV/DTO activation or Runtime pre-consumption of this cap.
    actRollingSummaryApply: async (step: Parameters<AgentLoopCoordinatorPorts['act']>[0], capability: AgentLoopRollingSummaryApplyCapability) => {
      let entered = false;
      try {
        assertStep(step);
        const readLive = () => {
          assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, job.sessionId, 'rolling_summary');
          const current = guard.assertLiveClaim();
          if (sessions.get(job.sessionId) !== initial.source.sessionIdentity || current.sessionIdentity !== initial.source.sessionIdentity) {
            throw new Error('agent-loop-maintenance-host-unavailable');
          }
          assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, job.sessionId, 'rolling_summary');
          return current;
        };
        readLive();
        const session = sessions.get(job.sessionId);
        if (!session || session !== initial.source.sessionIdentity) throw new Error('agent-loop-maintenance-host-unavailable');
        applyAdapter ??= createAgentLoopMaintenanceRollingSummaryApplyAction({ store: AGENT_LOOP_PROJECTION_STORE,
          manager: maintenanceJobs, ownerId, clock, signal, execution: initial.execution, fixedSource: initial.source,
          readCurrent, readLive, capability,
          committer: new MemorySummaryMaintenanceCommitter({ sessionId: job.sessionId, memory: session.getMemory().mem },
            (sessionId) => {
              if (sessionId !== job.sessionId || sessions.get(sessionId) !== session) throw new Error('agent-loop-maintenance-host-unavailable');
              return snapshotForSession(session).snapshotToken;
            }, clock) });
        entered = true;
        return await applyAdapter.act(step);
      } finally {
        revokeAgentLoopRollingSummaryApplyCapability(capability);
        if (entered) MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
      }
    },
  });
}

/** Lazy host MODEL port. Only the durable reservation winner can open one per-invocation handle.
 * Construction is read-only; the production Service claim fence remains fixed closed.
 */
function createAgentLoopMaintenanceHostModel(input: Readonly<{
  runId: string; taskId: string; expectedRevision: number; ownerId: string; signal: AbortSignal;
}>, rollingSummaryApplyCapability?: AgentLoopRollingSummaryApplyCapability) {
  const applySelected = arguments.length > 1;
  try {
  if (!agentLoopLegacySourceReady || !input || !input.signal || input.signal.aborted) {
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
  const { runId, taskId, expectedRevision, ownerId, signal } = input;
  const execution = maintenanceJobs.readExecution(runId);
  if (!execution || execution.executorRoute !== 'agent-loop' || execution.leaseOwnerInstanceId !== ownerId
    || execution.job.taskKind !== 'rolling_summary') throw new Error('agent-loop-maintenance-host-unavailable');
  const job = execution.job, environment = readMaintenanceModelHostEnvironment(job, true);
  const session = sessions.get(job.sessionId), record = AGENT_LOOP_PROJECTION_STORE.read(taskId);
  if (!environment || !session || environment.sessionIdentity !== session || !record || record.revision !== expectedRevision) {
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
  const ceilingBudgetProfile = normalizeAgentBudgetProfile(environment.budgetProfile);
  // The claim start and prepared ceiling are durable/stable. Creating a new wrapper never restarts this clock.
  const deadlineAtMs = Date.parse(job.startedAt ?? '') + ceilingBudgetProfile.maxWallMs;
  if (!Number.isSafeInteger(deadlineAtMs) || !Number.isFinite(new Date(deadlineAtMs).getTime())) {
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
  const budgetAt = (current: typeof record) => deriveAgentLoopModelCallBudget({ budget: current.envelope.budget,
    hostProfile: ceilingBudgetProfile, deadlineAtMs, nowMs: Date.now() });
  const checkRecord = (requireReservation: boolean, budgetProfile = budgetAt(record)) => {
    if (signal.aborted) throw new Error('agent-loop-maintenance-host-unavailable');
    return assertAgentLoopMaintenanceModelRecord({ store: AGENT_LOOP_PROJECTION_STORE,
      ownerId, clock: () => new Date().toISOString(), job, budgetProfile,
      envelope: record.envelope, revision: expectedRevision, requireReservation });
  };
  checkRecord(false);
  const assertApplyModel = (current = record) => {
    if (!applySelected) return;
    assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, job.sessionId, 'rolling_summary');
    assertAgentLoopRollingSummaryApplyModelCapability(rollingSummaryApplyCapability, {
      store: AGENT_LOOP_PROJECTION_STORE, ownerId, record: current,
    });
  };
  // Before any Client, Broker ticket or per-invocation handle is constructed.
  assertApplyModel();
  const snapshot = buildRollingSummarySnapshotForSession(session, job.sessionId, job.sourceRevision, {
    maxTokens: ceilingBudgetProfile.agentInputBudgetTokens, system: maintenanceSystemPrompt('rolling_summary'),
  });
  assertAgentLoopMaintenancePreparedBinding({ record, execution, source: { job, snapshot,
    profile: { providerId: environment.providerId, modelId: environment.modelId,
      runtimeProfile: environment.runtimeProfile, budgetProfile: ceilingBudgetProfile, policyVersion: job.policyVersion,
      contentMode: environment.contentMode } } });
  const constructionGuard = createMaintenanceModelHostGuard({ job, execution, verifiedSourceRevision: job.sourceRevision,
    budgetProfile: ceilingBudgetProfile, expectedExecutorRoute: 'agent-loop',
    readCurrent: () => readMaintenanceModelHostEnvironment(job, true), clock: () => new Date().toISOString() });
  let used = false;
  return Object.freeze({ async decide(step: Parameters<AgentLoopCoordinatorPorts['decide']>[0]) {
    let bundle: ReturnType<typeof createMaintenanceHostModel> | undefined;
    try {
    if (used) throw new Error('agent-loop-maintenance-host-unavailable');
    used = true;
    if (step.revision !== expectedRevision || JSON.stringify(step.envelope) !== JSON.stringify(record.envelope)) {
      throw new Error('agent-loop-maintenance-host-unavailable');
    }
    constructionGuard.assertCurrent();
    const budgetProfile = budgetAt(record), currentRecord = checkRecord(true, budgetProfile);
    assertApplyModel(currentRecord);
    const admissionScope = consumeAgentLoopModelInvocationPermit(step.invocationPermit, { record: currentRecord, ownerId,
      deadlineMs: Math.min(deadlineAtMs, Date.now() + budgetProfile.maxWallMs) });
    bundle = createMaintenanceHostModel(job, { execution, snapshot, verifiedSourceRevision: snapshot.revision,
      proposalContext: snapshot.providerProposalContext ?? snapshot.proposalContext, budgetProfile }, {
      ceilingBudgetProfile, admissionScope,
      assertCurrent: () => { constructionGuard.assertCurrent(); assertApplyModel(checkRecord(true, budgetProfile)); },
      assertDispatch: () => { constructionGuard.assertCurrent(); assertApplyModel(checkRecord(true, budgetProfile)); },
    });
    const currentBundle = bundle;
      const readCurrent = () => {
        const current = currentBundle.sourceGuard.assertCurrent(), fixed = currentBundle.sourceGuard.fixed;
        if (sessions.get(job.sessionId) !== session || current.sessionIdentity !== session) throw new Error('agent-loop-maintenance-host-unavailable');
        const currentSnapshot = buildRollingSummarySnapshotForSession(session, job.sessionId, current.sourceRevision, {
          maxTokens: ceilingBudgetProfile.agentInputBudgetTokens, system: maintenanceSystemPrompt('rolling_summary'),
        });
        const latest = currentBundle.sourceGuard.assertCurrent();
        return { execution: latest.execution, source: { job: latest.execution.job, snapshot: currentSnapshot,
          profile: { providerId: fixed.providerId, modelId: fixed.modelId, runtimeProfile: fixed.runtimeProfile,
            budgetProfile: ceilingBudgetProfile, policyVersion: fixed.job.policyVersion, contentMode: fixed.contentMode },
          sessionIdentity: session, hostDispatchGuarded: true as const } };
      };
      const fixedSource = readCurrent().source;
      const bridge = createAgentLoopMaintenanceModel({ store: AGENT_LOOP_PROJECTION_STORE, ownerId,
        clock: () => new Date().toISOString(), execution, fixedSource, handle: currentBundle.handle, callBudgetProfile: budgetProfile,
        readCurrent, signal, harnessRunId: job.runId,
        ...(applySelected ? { rollingSummaryApplyCapability } : {}) });
      return await bridge.decide(step);
    } catch (error) {
      try { bundle?.handle.finish('cancelled'); } catch { /* Do not expose a private source/sink failure. */ }
      if (applySelected) revokeAgentLoopRollingSummaryApplyCapability(rollingSummaryApplyCapability);
      // Before a handle exists, the original default path must retain its
      // precise permit error. Rejecting a forgery must not interrupt the genuine
      // pending winner or pretend that this wrapper owned a lease to finish.
      if (!applySelected && !bundle) throw error;
      throw new Error('agent-loop-maintenance-host-unavailable');
    }
  } });
  } catch (error) {
    if (applySelected) revokeAgentLoopRollingSummaryApplyCapability(rollingSummaryApplyCapability);
    if (!applySelected) throw error;
    throw new Error('agent-loop-maintenance-host-unavailable');
  }
}

// Default-off production composition for the first and only enabled cohort.
// The durable ControlStore remains the switch; merely constructing this exact
// port does not change its `off` migration default or claim an AL job.
const AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_PORT = AGENT_ADMISSION_LEDGER
  ? bindAgentLoopMaintenanceProductionCanaryExecutionPort(
      AGENT_LOOP_RUNTIME,
      maintenanceJobs,
      () => {
        // Reuse the one existing bounded pump after startup reconciliation.
        // This is only a wake; the exact port remains the claim authority.
        if (agentLoopLegacySourceReady) maintenanceDrainPump?.request();
      },
    )
  : null;
const AGENT_LOOP_MAINTENANCE_PRODUCTION_DISPATCHER = (() => {
  const admissionLedger = AGENT_ADMISSION_LEDGER;
  const agentLoop = AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_PORT;
  if (admissionLedger && agentLoop) {
    return createAgentLoopMaintenanceProductionDispatcher({
      manager: maintenanceJobs,
      mode: 'production-canary-5',
      admissionLedger,
      controlStore: AGENT_CONTROL_STORE,
      resolveSessionMemory: (sessionId) => sessions.get(sessionId)?.getMemory().mem ?? null,
      sourcePolicyReader: AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_READER,
      readRouteSnapshot:
        createAgentLoopMaintenanceProductionRouteSnapshotReaderInternal(AGENT_CONTROL_STORE),
      agentLoop,
    });
  }
  return createAgentLoopMaintenanceProductionDispatcher({
    manager: maintenanceJobs,
    mode: 'closed-legacy',
    // Without the Admission authority the production namespace stays on the
    // code-owned Legacy route and cannot obtain an AgentLoop claim.
    routeControl: Object.freeze({
      generation: AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2,
      state: 'off' as const,
      revision: 0,
    }),
  });
})();

maintenanceHarness = new MaintenanceHarnessService({
  manager: maintenanceJobs,
  productionDispatcher: AGENT_LOOP_MAINTENANCE_PRODUCTION_DISPATCHER,
  ownerInstanceId: `server.${SERVER_INSTANCE_ID}`,
  agentLoop: AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_PORT ?? {
    store: AGENT_LOOP_PROJECTION_STORE,
    // No Admission ledger means there is no exact production port. Keep the
    // historical hard fence so the fallback dispatcher remains Legacy-only.
    canClaim: () => false,
    execute: (context) => AGENT_LOOP_RUNTIME.executeMaintenance(context),
  },
  budgetFor: (job) => readMaintenanceModelProfile(job).budgetProfile,
  admissionOpen: releaseAdmissionOpen,
  foregroundActive: (sessionId) => turnJobs.getActiveForSession(sessionId) !== null,
  onPostTurnGraceElapsed: (sessionId) => {
    // A newer foreground turn may have consumed the wake. Its own settled event
    // resets the full grace window and schedules the next bounded drain.
    if (turnJobs.getActiveForSession(sessionId) !== null) return;
    maintenanceDrainPump?.request();
    STYLE_COMPILE_RUNTIME?.wakeSession(sessionId);
  },
  // Rechecked by the service both before enqueue and immediately before claim.
  executionAllowed: maintenanceTaskExecutionAllowed,
  observeRuntime: (input) => {
    recordMaintenanceProtocolObservation(input);
  },
  observeLifecycle: (input) => {
    // Header-only projection/fence; the existing Maintenance Manager still owns
    // every Provider call and business write, including retries and recovery.
    AGENT_LOOP_RUNTIME.observeMaintenanceJobPhase({ runId: input.job.runId, phase: input.phase });
    publishMaintenanceLifecycleInvalidation(eventHub, input);
    let directOwnsEvidence = false;
    if (input.phase === 'settled' && input.job.taskKind === 'memory_consolidation') {
      try { directOwnsEvidence = maintenanceJobs.getMemoryDirectProposal(input.job.runId) !== null; }
      catch { directOwnsEvidence = true; AGENT_CLOSURE_DEGRADED = true; }
    }
    if (input.phase === 'settled' && input.job.taskKind === 'rolling_summary') {
      try { directOwnsEvidence = maintenanceJobs.readSummarySkillProvenance(input.job.runId) !== null; }
      catch { directOwnsEvidence = true; AGENT_CLOSURE_DEGRADED = true; }
    }
    // Prepared direct writes own their original pre-COMMIT milestones, even if task settlement later fails.
    if (!directOwnsEvidence) AGENT_CLOSURE_RECORDER?.observeMaintenanceLifecycle(input);
    if (input.phase === 'settled') {
      MAINTENANCE_MEMORY_SKILL_SCHEDULER?.schedule();
      MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
      MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
    }
  },
  beforeManagerClose: () => settleAgentLoopManagerReadersBeforeClose(),
  observeCommitted: ({ job }) => {
    // Receipt stays internal. Only a real pre-COMMIT preparation can join this write to its source.
    if (job.taskKind === 'memory_consolidation') MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
    if (job.taskKind === 'rolling_summary') MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
  },
  onShadowProposal: applyGuardedNpcProposal,
  onWorldbookRepairProposal: registerWorldbookRepairProposal,
  loadSnapshot: async (sessionId, taskKind, _expectedRevision, providerInput) => {
    const session = await loadSessionById(sessionId);
    if (!session) throw new Error('maintenance-session-not-found');
    const revision = snapshotForSession(session).snapshotToken;
    const worldbookRepairContext = taskKind === 'worldbook_repair'
      ? maintenanceWorldbookRepairContext(session, sessionId, maintenanceWorldbookSkillLiveEnabled(process.env))
      : undefined;
    const maintenanceSnapshot = taskKind === 'rolling_summary'
      ? buildRollingSummarySnapshotForSession(session, sessionId, revision, providerInput)
      : taskKind === 'branch_index'
      ? buildBranchIndexSnapshotForSession(session, sessionId, revision, providerInput)
      : buildMaintenanceSessionSnapshot({
      session,
      sessionId,
      revision,
      taskKind,
      worldbookEntries: maintenanceWorldbookEntries(session),
      providerInputBudget: providerInput,
      ...(worldbookRepairContext ? { worldbookRepairContext } : {}),
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
  modelFor: (job, binding) => createMaintenanceHostModel(job, binding).handle,
  // P16 E2（用户裁定：所有 agent 推入正式写入）：
  // - memory_consolidation / rolling_summary → 走 MemorySummaryMaintenanceCommitter
  //   （现成 typed 提交器：操作账本 + CAS + 回执 + 回滚锚，操作者路径已在用）；
  // - npc_state 保持 shadow（走 onShadowProposal 的**审计式** guarded-auto：
  //   apply-policy 限额 + occupied-targets 审计 + 备份，不能被直接提交绕过）；
  // - branch_index / worldbook_repair 保持 shadow（各自的操作者/控制面路径）。
  resolveMode: (sessionId, taskKind) => {
    if (taskKind !== 'memory_consolidation' && taskKind !== 'rolling_summary') return 'shadow';
    return maintenanceMemorySummaryApplyMode(
      MAINTENANCE_APPLY_RUNTIME,
      sessionId,
      taskKind,
    );
  },
  committer: {
    commit: async (request) => {
      if (request.taskKind !== 'memory_consolidation' && request.taskKind !== 'rolling_summary') {
        throw new Error('maintenance-apply-task-kind-unsupported');
      }
      // Defense in depth: do not trust the mode persisted on a queued job. The
      // acknowledged exact/managed-local business-write grant is rechecked at the final boundary.
      assertMaintenanceMemorySummaryCommitAllowed(
        MAINTENANCE_APPLY_RUNTIME,
        request.sessionId,
        request.taskKind,
      );
      if (!request.context) throw new Error('maintenance-apply-context-missing');
      const session = await loadSessionById(request.sessionId);
      if (!session) throw new Error('maintenance-session-not-found');
      if (request.taskKind === 'memory_consolidation') {
        assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, request.sessionId, request.taskKind);
        assertMaintenanceMemoryDirectWriteAllowed(request, {
          manager: maintenanceJobs,
          allowed: (id) => sessionDeletionAdmissionOpen(id) && maintenanceTaskExecutionAllowed(id, request.taskKind),
        });
      } else {
        assertMaintenanceMemorySummaryCommitAllowed(MAINTENANCE_APPLY_RUNTIME, request.sessionId, request.taskKind);
        assertMaintenanceSummaryDirectWriteAllowed(request, {
          manager: maintenanceJobs,
          allowed: (id) => sessionDeletionAdmissionOpen(id) && maintenanceTaskExecutionAllowed(id, request.taskKind),
        });
      }
      const memorySummary = new MemorySummaryMaintenanceCommitter({
        sessionId: request.sessionId,
        memory: session.getMemory().mem,
      }, () => snapshotForSession(session).snapshotToken);
      const commitInput = {
        jobRunId: request.runId,
        sessionId: request.sessionId,
        taskKind: request.taskKind,
        sourceRevision: request.expectedRevision,
        proposal: request.proposal,
        context: request.context,
      };
      const write = () => memorySummary.commit(commitInput);
      const committed = request.taskKind === 'rolling_summary'
        ? withMaintenanceSummaryWriteWake(write, () => MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule())
        : withMaintenanceMemoryWriteWake(write, () => {
          MAINTENANCE_MEMORY_SKILL_SCHEDULER?.schedule();
          MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
        });
      if (committed.status === 'stale') {
        return { status: 'stale' as const, actualRevision: committed.actualRevision, diff: shadowDiff(request.proposal) };
      }
      return {
        status: 'committed' as const,
        revision: String((committed.receipt as { revision?: unknown }).revision ?? request.expectedRevision),
        diff: shadowDiff(request.proposal),
        receipt: committed.receipt,
      };
    },
  },
});
/**
 * Session deletion has two fences: a process-local reservation closes the
 * pre-CAS race, then the privacy journal becomes the permanent tombstone.
 * Cleanup is replayable and starts only after both foreground and background
 * executors (including their observer callbacks) have settled.
 */
const SESSION_DELETION_COORDINATOR = new SessionDeletionCoordinator({
  journal: SESSION_DELETION_JOURNAL,
  reserve(identity) {
    if (SESSION_DELETION_RESERVATIONS.has(identity.sessionId)) {
      throw new Error('session-deletion-reservation-conflict');
    }
    const reservation: SessionDeletionReservation = Object.freeze({
      sessionId: identity.sessionId,
      operationId: identity.operationId,
      reservationId: `sdelete-reservation:${randomUUID()}`,
    });
    SESSION_DELETION_RESERVATIONS.set(identity.sessionId, reservation);
    return reservation;
  },
  release(reservation) {
    if (SESSION_DELETION_RESERVATIONS.get(reservation.sessionId)?.reservationId
      === reservation.reservationId) {
      SESSION_DELETION_RESERVATIONS.delete(reservation.sessionId);
      DIRECTOR_CREATIVE_SERVICE?.releaseQuiescence(reservation.sessionId);
    }
  },
  async quiesce({ identity }) {
    await Promise.all([
      turnJobs.quiesceSession(identity.sessionId),
      maintenanceHarness!.quiesceSession(identity.sessionId),
      SKILL_COMPILE_RUNTIME?.quiesceSession(identity.sessionId),
      SKILL_EVALUATE_RUNTIME?.quiesceSession(identity.sessionId),
      SKILL_SAMPLE_RUNTIME?.quiesceSession(identity.sessionId),
      SKILL_QUALITY_RUNTIME?.quiesceSession(identity.sessionId),
      STYLE_COMPILE_RUNTIME?.quiesceSession(identity.sessionId),
      DIRECTOR_CREATIVE_SERVICE?.quiesceSession(identity.sessionId),
      CONTEXT_COMPILER_SHADOW_RUNNER.cancelSession(identity.sessionId),
    ]);
  },
  readRevision(sessionId) {
    const session = sessions.get(sessionId);
    if (session) return snapshotForSession(session).snapshotToken;
    const dbPath = resolveSessionDatabase(DATA_DIR, `${sessionId}.db`);
    if (!dbPath || !existsSync(dbPath)) return ABSENT_REVISION;
    const revision = readSessionMeta(dbPath).snapshotToken;
    if (!revision) throw new Error('session-deletion-snapshot-unavailable');
    return revision;
  },
  cleanupSteps: [
    {
      id: 'style-compile-jobs', failureCode: 'style-compile-delete-failed',
      async run(identity) {
        if (STYLE_COMPILE_RUNTIME) await STYLE_COMPILE_RUNTIME.redactSession(identity.sessionId);
        else if (existsSync(resolve(DATA_DIR, STYLE_COMPILE_JOB_DATA_DIRECTORY, STYLE_COMPILE_JOB_DB_FILE))) {
          throw new Error('style-compile-store-unavailable');
        }
      },
    },
    {
        id: 'skill-quality-source',
        failureCode: 'skill-quality-delete-failed',
        run(identity) {
            if (SKILL_QUALITY_RUNTIME) SKILL_QUALITY_RUNTIME.redactSession(identity.sessionId);
            else if (existsSync(resolve(DATA_DIR, SKILL_QUALITY_DB_FILE))) {
                throw new Error('skill-quality-store-unavailable');
            }
        },
    },
    {
        id: 'skill-sample-source',
        failureCode: 'skill-sample-delete-failed',
        run(identity) {
            if (SKILL_SAMPLE_RUNTIME) SKILL_SAMPLE_RUNTIME.redactSession(identity.sessionId);
            else if (existsSync(resolve(DATA_DIR, SKILL_SAMPLE_DB_FILE))) {
                throw new Error('skill-sample-store-unavailable');
            }
        },
    },
    {
        id: 'skill-evaluate-source',
        failureCode: 'skill-evaluate-delete-failed',
        run(identity) {
            if (SKILL_EVALUATE_RUNTIME) SKILL_EVALUATE_RUNTIME.redactSession(identity.sessionId);
            else if (existsSync(resolve(DATA_DIR, SKILL_EVALUATE_DB_FILE))) {
                throw new Error('skill-evaluate-store-unavailable');
            }
        },
    },
    {
        id: 'skill-compile-source',
        failureCode: 'skill-compile-delete-failed',
        run(identity) {
            if (SKILL_COMPILE_RUNTIME) SKILL_COMPILE_RUNTIME.redactSession(identity.sessionId);
            else if (existsSync(resolve(DATA_DIR, SKILL_COMPILE_DB_FILE))) {
                throw new Error('skill-compile-store-unavailable');
            }
        },
    },
    {
        id: 'agent-evidence',
        failureCode: 'agent-evidence-delete-failed',
        run(identity) {
            EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            CLOSURE_SKILL_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            ARC_COMMIT_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            WORLDBOOK_APPLY_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            NPC_OPERATION_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            REGENERATION_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            VARIABLE_APPLY_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            REPORTED_EFFECT_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            BRANCH_MODIFIED_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            AQL_ADVISORY_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            NSFW_SCENE_EVIDENCE_SCHEDULER?.cancel(identity.sessionId);
            if (AGENT_EVIDENCE_LEDGER) AGENT_EVIDENCE_LEDGER.redactSession(identity.sessionId);
            else if (existsSync(resolve(DATA_DIR, AGENT_EVIDENCE_DB_FILE))) {
                throw new Error('agent-evidence-ledger-unavailable');
            }
        },
    },
    {
      id: 'learning-evidence',
      failureCode: 'learning-delete-failed',
      run(identity) {
        LEARNING_PREFERENCE_SOURCE_SCHEDULER?.cancel(identity.sessionId);
        if (!AGENT_LEARNING_LEDGER) throw new Error('agent-learning-ledger-unavailable');
        AGENT_LEARNING_LEDGER.deleteScope({
          sessionId: opaqueLearningToken('session', identity.sessionId),
        });
      },
    },
    {
      id: 'worldbook-repair-control',
      failureCode: 'worldbook-repair-delete-failed',
      run(identity) {
        // The control is constructed whenever its sidecar exists. A null value
        // therefore means there is no worldbook-repair database to redact.
        WORLDBOOK_REPAIR_CONTROL?.deleteSession(identity.sessionId);
      },
    },
    {
      id: 'npc-maintenance-activation',
      failureCode: 'npc-maintenance-activation-delete-failed',
      run(identity) {
        deleteNpcMaintenanceActivationSession(DATA_DIR, identity.sessionId);
      },
    },
    {
      id: 'learned-style-proposals',
      failureCode: 'learned-style-delete-failed',
      run(identity) {
        LEARNED_STYLE_PROPOSALS.deleteSessionScope(
          opaqueLearningToken('session', identity.sessionId),
        );
      },
    },
    {
      id: 'model-usage',
      failureCode: 'model-usage-delete-failed',
      run(identity) {
        MODEL_USAGE_LEDGER.redactSession(identity.sessionId);
      },
    },
    {
      id: 'director-creative',
      failureCode: 'director-creative-delete-failed',
      async run(identity) { await DIRECTOR_CREATIVE_SERVICE?.deleteSource(identity.sessionId); },
    },
    {
      id: 'agent-admission',
      failureCode: 'agent-admission-delete-failed',
      run(identity) {
        // Null means the runtime was disabled and no historical DB existed at
        // startup. Existing databases are always reopened above.
        AGENT_ADMISSION_LEDGER?.deleteSession(identity.sessionId);
      },
    },
    {
      id: 'interactive-calls',
      failureCode: 'interactive-calls-delete-failed',
      run(identity) {
        // Runtime-off does not skip an existing database: it is reopened above.
        INTERACTIVE_CALL_LEDGER?.deleteSession(identity.sessionId);
      },
    },
    {
      id: 'agent-control-references',
      failureCode: 'agent-control-references-delete-failed',
      run(identity) {
        AGENT_CONTROL_STORE.deleteSessionReferences(identity.sessionId);
      },
    },
    {
      id: 'arc-projection',
      failureCode: 'arc-projection-delete-failed',
      run(identity) {
        ARC_PROJECTIONS?.deleteSession(identity.sessionId);
      },
    },
    {
      id: 'maintenance-jobs',
      failureCode: 'maintenance-jobs-delete-failed',
      run(identity) {
        maintenanceJobs.deleteSession(identity.sessionId);
      },
    },
    {
      id: 'turn-jobs',
      failureCode: 'turn-jobs-delete-failed',
      run(identity) {
        turnJobs.deleteSessionAfterPrivacyFence(identity.sessionId);
      },
    },
    {
      id: 'agent-closure',
      failureCode: 'agent-closure-delete-failed',
      run(identity) {
        // The closure ledger is privacy evidence, not a disposable cache.
        // If it could not be opened, preserve the durable deletion fence and
        // leave this step pending instead of reporting a false cleanup success.
        SKILL_CONSUMPTION_SCHEDULER?.cancel(identity.sessionId);
        MAINTENANCE_MEMORY_CONSUMPTION_SCHEDULER?.cancel(identity.sessionId);
        MAINTENANCE_SUMMARY_CONSUMPTION_SCHEDULER?.cancel(identity.sessionId);
        if (!AGENT_CLOSURE_STORE) throw new Error('agent-closure-store-unavailable');
        AGENT_CLOSURE_STORE.redactSession(identity.sessionId);
      },
    },
    createP14EvidenceSessionDeletionStep(DATA_DIR),
    {
      id: 'snapshot-artifacts',
      failureCode: 'snapshot-artifacts-delete-failed',
      run(identity) {
        cleanupDeletedSessionSnapshotArtifacts({
          dataDir: DATA_DIR,
          sessionId: identity.sessionId,
        });
      },
    },
    createDshSessionDeletionStep(dshHost),
    {
      id: 'session-files',
      failureCode: 'session-files-delete-failed',
      async run(identity) {
        const pendingLoad = sessionLoadPromises.get(identity.sessionId);
        if (pendingLoad) await Promise.allSettled([pendingLoad]);
        await CONTEXT_COMPILER_SHADOW_RUNNER.cancelSession(identity.sessionId);
        const session = sessions.get(identity.sessionId);
        if (session) {
          // A failed close may retain a Windows file handle. Keep the instance
          // in the map and leave this journal step pending so retry can close it.
          session.close();
        }
        sessions.delete(identity.sessionId);
        const dbPath = resolveSessionDatabase(DATA_DIR, `${identity.sessionId}.db`);
        if (!dbPath) throw new Error('session-deletion-path-invalid');
        for (const suffix of ['', '-wal', '-shm']) {
          const path = suffix ? `${dbPath}${suffix}` : dbPath;
          if (existsSync(path)) rmSync(path, { force: true });
        }
      },
    },
    {
      id: 'pgvector-namespace',
      failureCode: 'pgvector-namespace-delete-failed',
      async run(identity) {
        const result = await (await getPgVectorStore()).purgeNamespace(identity.sessionId);
        if (result.status !== 'purged') throw new Error('pgvector-namespace-not-purged');
      },
    },
  ],
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

/**
 * 世界书修正的可改证据（严格只读）。
 *
 * 只列**本会话实际绑定**的世界书；每本给出当前 revision 与逐条 (稳定 uid, digest)。
 * 这些值同时构成提案的唯一合法取值域：`normalizeWorldbookRepairProposalWithContext`
 * 会逐条比对 sessionId / file / expectedRevision / evidenceSetDigest / 条目 digest，
 * 模型无法自造条目或版本。
 *
 * ⚠️ digest 必须与 `buildAfterImage` **同源** —— 两者都对 `rawEntriesOf` 取出的
 * **磁盘原始条目**计算，而不是 `parseWorldBook` 规范化后的形状；否则 apply 阶段会以
 * `worldbook-repair-entry-revision-conflict` 全量拒绝提案。
 */
function maintenanceWorldbookRepairContext(
  session: ChatSession,
  sessionId: string,
  required = false,
): WorldbookRepairProposalContext | undefined {
  const files: WorldbookRepairFileEvidence[] = [];
  for (const file of session.getSessionConfig().worldbooks.slice(0, 8)) {
    if (!isSafeAssetFileName(file)) {
      if (required) throw new Error('maintenance-worldbook-skill-source-invalid');
      continue;
    }
    let asset: { raw: string; revision: string } | null = null;
    try { asset = readRevisionedAsset('worldbook', file); } catch { asset = null; }
    if (!asset) {
      if (required) throw new Error('maintenance-worldbook-skill-source-invalid');
      continue;
    }
    const entries: Array<{ entryUid: string; digest: string }> = [];
    try {
      const parsed: unknown = JSON.parse(asset.raw);
      const seen = new Set<string>();
      for (const raw of rawEntriesOf(parsed).entries.slice(0, 64)) {
        const uid = stableEntryUid(raw);
        if (uid === null || seen.has(uid)) {
          if (required) throw new Error('maintenance-worldbook-skill-source-invalid');
          continue;
        }
        seen.add(uid);
        entries.push({ entryUid: uid, digest: worldbookEntryDigest(raw) });
      }
    } catch {
      if (required) throw new Error('maintenance-worldbook-skill-source-invalid');
      continue;
    }
    if (entries.length === 0) {
      if (required) throw new Error('maintenance-worldbook-skill-source-invalid');
      continue;
    }
    const evidenceSetDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify({ file, revision: asset.revision, entries }), 'utf8').digest('hex')}`;
    files.push({ file, expectedRevision: asset.revision, evidenceSetDigest, entries });
  }
  if (required && files.length === 0) throw new Error('maintenance-worldbook-skill-context-required');
  return files.length > 0 ? { sessionId, files } : undefined;
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

function ensureAssetIdentityInMutation(
  kind: 'card' | 'preset' | 'worldbook',
  file: string,
  displayName?: string,
): LocalAssetIdentity {
  const current = ASSET_IDENTITIES.findByStorageKey(kind, file);
  if (current && displayName === undefined) return current;
  return ASSET_IDENTITIES.ensure(kind, file, displayName?.trim() || assetDisplayName(file));
}

function ensureAssetIdentity(
  kind: 'card' | 'preset' | 'worldbook',
  file: string,
  displayName?: string,
): LocalAssetIdentity {
  const current = ASSET_IDENTITIES.findByStorageKey(kind, file);
  const nextDisplayName = displayName?.trim() || assetDisplayName(file);
  if (current && (displayName === undefined || current.displayName === nextDisplayName)) return current;
  return AGENT_CONTROL_STORE.withAssetMutation(
    () => ensureAssetIdentityInMutation(kind, file, displayName),
  );
}

function ensureDiscoveredAssetIdentities(
  entries: readonly {
    kind: 'card' | 'preset' | 'worldbook';
    storageKey: string;
    displayName: string;
  }[],
): void {
  if (entries.every((entry) => ASSET_IDENTITIES.findByStorageKey(entry.kind, entry.storageKey))) return;
  AGENT_CONTROL_STORE.withAssetMutation(() => ASSET_IDENTITIES.ensureDiscovered(entries));
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
    case 'skill_package_output_invalid': return 'Skill Canary 回合输出未通过校验，本次已停止';
    case 'skill_package_budget_exhausted': return 'Skill Canary 回合预算已耗尽，本次已停止';
    case 'skill_package_shadow_output_invalid': return 'Skill Shadow 回合输出未通过校验，本次已停止';
    case 'skill_package_shadow_budget_exhausted': return 'Skill Shadow 回合预算已耗尽，本次已停止';
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

const MAX_NSFW_AGENT_STATE_BYTES = 32 * 1024;

/**
 * Bind an external NSFW state envelope to exactly one durable turn job. The
 * agent-policy layer performs field allow-listing; this HTTP boundary rejects
 * oversized/non-JSON shapes and unsafe XML declarations before persistence.
 */
function parseNsfwAgentStatePayload(raw: unknown): unknown | undefined {
  if (raw === undefined || raw === null) return undefined;
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_NSFW_AGENT_STATE_BYTES
      || /<!DOCTYPE|<!ENTITY/iu.test(text)) {
      throw new Error('nsfw_state 必须是有界 JSON 或 <nsfw_state> XML');
    }
    if (/^[\[{]/u.test(text)) {
      try {
        payload = JSON.parse(text) as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('shape');
      } catch {
        throw new Error('nsfw_state 必须是合法的 JSON 对象');
      }
    } else if (!/^<nsfw(?:[-_:]?state)?(?:\s|>)/iu.test(text)) {
      throw new Error('nsfw_state 必须是有界 JSON 或 <nsfw_state> XML');
    } else {
      payload = text;
    }
  } else {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('nsfw_state 必须是对象、JSON 或 XML');
    const serialized = JSON.stringify(raw);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_NSFW_AGENT_STATE_BYTES) {
      throw new Error('nsfw_state 过大');
    }
  }
  const parsed = parseNsfwAgentState(payload, typeof payload === 'object');
  if (typeof payload === 'string' && parsed.source !== 'xml') {
    throw new Error('nsfw_state 必须是完整的 <nsfw_state> XML');
  }
  // Persist only the allow-listed canonical projection. Raw XML and unrelated
  // JSON fields never reach a durable turn job or the main model query.
  return {
    version: 'nsfw-agent-state-v1',
    ...(parsed.active === null ? {} : { active: parsed.active }),
    retrieval: parsed.retrieval,
    ...(parsed.confidence === null ? {} : { confidence: parsed.confidence }),
    ...(parsed.scene ? { scene: parsed.scene } : {}),
    ...(parsed.phase ? { phase: parsed.phase } : {}),
    participants: [...parsed.participants],
  };
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
    const mem = new MemoryDb({ path: dbPath, readOnly: true });
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
      return json(res, {
        ok: true,
        app: 'jiuguan',
        version: APP_VERSION,
        agentClosure: AGENT_CLOSURE_DEGRADED ? 'degraded' : 'ok',
      });
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

    // One deletion fence protects every path-addressed session read/write. This
    // check runs after auth/CSRF/rate admission (no tombstone oracle) and before
    // any handler reads a body or touches ChatSession/Agent sidecars.
    const routedSessionId = sessionScopedRouteTarget(routeAccess, p);
    if (routedSessionId && isSafeOpaqueId(routedSessionId, 160)
      && !sessionDeletionAdmissionOpen(routedSessionId)) {
      req.resume();
      securityAuditSpan?.annotate({ reasonCode: 'session-deleting' });
      return dshJson(res, {
        error: '会话正在删除，暂时拒绝访问',
        code: 'session-deleting',
        requestId,
      }, 409);
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
          if (dshHost.count() > 0 && (await dshHost.dispatch(req, res, p))) return;
    }

    // 角色卡列表
    if (method === 'GET' && p === '/api/assets/local') {
      const cards = listCards();
      const presets = listAssets('preset');
      const worldbooks = listAssets('worldbook');
      ensureDiscoveredAssetIdentities([
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
      ensureDiscoveredAssetIdentities(listedCards.map((card) => ({
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
      const list = dbs.flatMap((f) => {
        const dbPath = resolve(DATA_DIR, f);
        const id = f.replace(/\.db$/, '');
        if (isSafeOpaqueId(id, 160) && SESSION_DELETION_JOURNAL.isBlocked(id)) return [];
        const meta = readSessionMeta(dbPath);
        return [{
          id,
          file: f,
          name: meta.card || id,
          preview: meta.preview,
          round: meta.round,
          start: meta.start,
          createdAt: meta.createdAt,
          revision: meta.revision,
          snapshotToken: meta.snapshotToken,
        }];
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
      // 卡片导入会话（PNG 卡由 ChatSession 内部解包，见 packages/session/src/session.ts init）
      sse(res);
      try {
        const dbName = `session-${Date.now()}.db`;
        const dbPath = resolve(DATA_DIR, dbName);
        const id = dbName.replace(/\.db$/, '');
        const mode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
        let presetOverrides: Record<string, boolean> | undefined;
        if (body.preset_overrides && typeof body.preset_overrides === 'object') {
          presetOverrides = body.preset_overrides as Record<string, boolean>;
        }
        let session: ChatSession;
        session = new ChatSession({
          card: cardRes.path, db: dbPath, resume: false, useBge: false, contentMode: mode,
          worldbooks: worldbooks.length > 0 ? worldbooks : undefined,
          preset: preset ?? undefined,
          presetOverrides,
          style: typeof body.style === 'string' && body.style ? body.style : undefined,
          ...sessionProviderArgsForServer(id),
          toolResultBodyAccess: toolResultBodyAccessForSession(id, () => session),
          skillSelectionObserver: skillSelectionObserverForSession(id),
          stylePackageShadowRequired: () => STYLE_PACKAGE_SHADOW_ENABLED && SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.allowsSession(id),
          stylePackageShadowRejected: input => STYLE_PACKAGE_SHADOW.rejectTurn(input),
          stylePackageCanary: STYLE_PACKAGE_CANARY,
          learnedStyleResolver: learnedStyleResolverForSession(id),
          commitLearnedStyleAdoption: learnedStyleAdoptionForSession(id),
          aqlReplanSkillRequired: () => aqlReplanSkillLiveEnabled(process.env),
          interactiveHarness: interactiveHarnessForSession(id),
          agentAdmission: agentAdmissionForSession(id),
          variableProposalSkill: variableProposalSkillForSession(id),
          nsfwSceneSkill: nsfwSceneSkillForSession(id),
          nsfwSceneSafetyResolver: () => NSFW_SCENE_SAFETY_CONTROL.resolveSnapshot({
            dbPath,
            sessionId: id,
            manifest: session.getWorldbookSourceManifest(),
          }),
          maintenanceHistoryReconcile: ({ sessionId: callbackSessionId, rollbackRound, historyEpoch }) => {
            if (callbackSessionId !== id || session.getHistoryEpoch() !== historyEpoch) {
              throw new Error('maintenance-history-reconcile-fence-mismatch');
            }
            const committer = new MemorySummaryMaintenanceCommitter({
              sessionId: id,
              memory: session.getMemory().mem,
            }, () => snapshotForSession(session).snapshotToken);
            const reconciled = committer.reconcileHistoryRollback(rollbackRound);
            queueMicrotask(() => STYLE_COMPILE_RUNTIME?.wakeSession(id));
            if (reconciled.rolledBackRunIds.length > 0) {
              MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
              MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
              queueMicrotask(() => {
                MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.schedule(id);
                MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.schedule(id);
              });
            }
          },
          quietLogs: ACCESS_MODE === 'secured',
        });
        await session.init((stage) => sseSend(res, { type: 'stage', stage }), requestAbortController?.signal);
        if (shuttingDown) { session.close(); throw new Error('server-shutting-down'); }
        try { hydrateLearningFromLedger(session); } catch { /* 本地空/可重建投影继续，不阻断建档 */ }
        sessions.set(id, session);
        STYLE_COMPILE_RUNTIME?.wakeSession(id);
        SKILL_CONSUMPTION_SCHEDULER?.schedule(id);
        LEARNING_PREFERENCE_SOURCE_SCHEDULER?.schedule(id);
        EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER?.schedule(id);
        CLOSURE_SKILL_EVIDENCE_SCHEDULER?.schedule(id);
        MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.schedule(id);
        MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.schedule(id);
        MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER?.schedule(id);
        MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER?.schedule(id);
        ARC_COMMIT_EVIDENCE_SCHEDULER?.schedule(id);
        WORLDBOOK_APPLY_EVIDENCE_SCHEDULER?.schedule(id);
        NPC_OPERATION_EVIDENCE_SCHEDULER?.schedule(id);
        REGENERATION_EVIDENCE_SCHEDULER?.schedule(id);
        STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER?.schedule(id);
        VARIABLE_APPLY_EVIDENCE_SCHEDULER?.schedule(id);
        VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER?.schedule(id);
        REPORTED_EFFECT_EVIDENCE_SCHEDULER?.schedule(id);
        BRANCH_MODIFIED_EVIDENCE_SCHEDULER?.schedule(id);
        BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER?.schedule(id);
        PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER?.schedule(id);
        AQL_ADVISORY_EVIDENCE_SCHEDULER?.schedule(id);
        NSFW_SCENE_EVIDENCE_SCHEDULER?.schedule(id);
        MAINTENANCE_MEMORY_CONSUMPTION_SCHEDULER?.schedule(id);
        MAINTENANCE_SUMMARY_CONSUMPTION_SCHEDULER?.schedule(id);
        MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
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
      if (!sessionDeletionAdmissionOpen(sessionId)) {
        return json(res, { error: '会话正在删除', code: 'session-deleting' }, 409);
      }
      const session = sessions.get(sessionId);
      if (!session) return json(res, { error: '会话不存在，请先创建或恢复', code: 'session-not-found' }, 404);
      let round: number;
      let input: string | undefined;
      let attachments: ImageAttachment[] | undefined;
      let branchSelection: BranchSelectionReference | undefined;
      let nsfwState: unknown;
      const contentMode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
      if (action === 'turn') {
        input = String(body.input ?? '').trim();
        try {
          attachments = parseImageAttachments(body.attachments);
          branchSelection = parseBranchSelection(body.branchSelection);
          nsfwState = parseNsfwAgentStatePayload(body.nsfw_state);
        } catch (error) {
          const message = (error as Error).message.slice(0, 200);
          return json(res, {
            error: message,
            code: message.startsWith('nsfw_state') ? 'nsfw-state-invalid' : 'attachments-invalid',
          }, 400);
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
          ...(nsfwState === undefined ? {} : { nsfwState }),
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
        if (!sessionDeletionAdmissionOpen(existing.sessionId)) {
          return json(res, { error: '会话正在删除', code: 'session-deleting' }, 409);
        }
        return json(res, { job: turnJobs.cancel(runId) });
      } catch (error) {
        if (error instanceof TurnJobConflictError) {
          return json(res, { error: error.message, code: error.code, runId }, 409);
        }
        return json(res, { error: '取消生成任务失败', code: 'turn-job-cancel-failed' }, 400);
      }
    }

    const turnJobCandidateRoute = matchRouteTemplate('/api/turn-jobs/:runId/candidate', p);
    if (method === 'GET' && turnJobCandidateRoute) {
      const runId = turnJobCandidateRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      const job = turnJobs.get(runId);
      if (!job || !sessionDeletionAdmissionOpen(job.sessionId))
        return json(res, { error: '候选不可用', code: 'turn-candidate-not-found' }, 404);
      const candidate = turnJobs.manager.failedCandidate(runId);
      return candidate ? json(res, { sessionId: job.sessionId, runId, ...candidate })
        : json(res, { error: '候选不可用', code: 'turn-candidate-not-found' }, 404);
    }
    const turnJobGetRoute = matchRouteTemplate('/api/turn-jobs/:runId', p);
    if (method === 'GET' && turnJobGetRoute) {
      const runId = turnJobGetRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      const job = turnJobs.get(runId);
      if (job && !sessionDeletionAdmissionOpen(job.sessionId)) {
        return json(res, { error: '会话正在删除', code: 'session-deleting' }, 409);
      }
      const progress = job ? turnJobs.getProgress(runId) : null;
      return job
        ? json(res, { job, ...(progress ? { progress } : {}) })
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

    // Maintenance 的读取面可以通过已配对的私有远程入口观察，但开关、取消与任务写入
    // 会立即影响 Provider 调用和费用，因此必须再经过一道“电脑本机 authority”门禁。
    // 这道门禁故意与 JG_AGENT_CONTROL_MUTATION 无关：Maintenance API 本身已是显式控制面，
    // 但远程配对 admin 仍只能读取，不能利用 admin scope 越过本机操作边界。
    const requireLocalMaintenanceMutation = (): boolean => {
      const access = authorizeAgentControlMutation({
        runtime: { enabled: true },
        authority: authority.authority,
        localAuthorities: LOCAL_AUTHORITIES,
        accessMode: ACCESS_MODE,
        authenticatedAdmin: authenticatedContext?.isAdmin === true,
      });
      if (access.allowed) return true;
      req.resume();
      securityAuditSpan?.annotate({ reasonCode: access.reasonCode });
      dshJson(res, {
        error: 'Maintenance 写入仅允许电脑本机管理员入口',
        code: access.reasonCode,
        requestId,
      }, 403);
      return false;
    };

    if (method === 'POST' && p === '/api/maintenance/control') {
      if (!requireLocalMaintenanceMutation()) return;
      const body = await readBody(req);
      if (Object.keys(body).some((key) => key !== 'globalEnabled')
        || typeof body.globalEnabled !== 'boolean') {
        return json(res, { error: 'maintenance control 请求非法', code: 'maintenance-control-invalid' }, 400);
      }
      if (body.globalEnabled && !MAINTENANCE_RUNTIME.enabled) {
        return json(res, { error: '后台 Harness 未由宿主显式启用', code: 'maintenance-runtime-disabled' }, 409);
      }
      maintenanceHarness!.setGlobalEnabled(body.globalEnabled);
      if (body.globalEnabled) maintenanceDrainPump?.request();
      return json(res, { ok: true, globalEnabled: maintenanceJobs.globalEnabled() });
    }

    const maintenanceJobCancelRoute = matchRouteTemplate('/api/maintenance-jobs/:runId/cancel', p);
    if (method === 'POST' && maintenanceJobCancelRoute) {
      if (!requireLocalMaintenanceMutation()) return;
      const runId = maintenanceJobCancelRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      await readBody(req);
      const existing = maintenanceHarness!.get(runId);
      if (!existing) return json(res, { error: 'maintenance job 不存在', code: 'maintenance-job-not-found' }, 404);
      if (!sessionDeletionAdmissionOpen(existing.sessionId)) {
        return json(res, { error: '会话正在删除', code: 'session-deleting' }, 409);
      }
      return json(res, { job: maintenanceHarness!.cancel(runId) });
    }

    const maintenanceJobGetRoute = matchRouteTemplate('/api/maintenance-jobs/:runId', p);
    if (method === 'GET' && maintenanceJobGetRoute) {
      const runId = maintenanceJobGetRoute.runId;
      if (!isSafeOpaqueId(runId)) return json(res, { error: 'runId 非法', code: 'run-id-invalid' }, 400);
      const job = maintenanceHarness!.get(runId);
      if (job && !sessionDeletionAdmissionOpen(job.sessionId)) {
        return json(res, { error: '会话正在删除', code: 'session-deleting' }, 409);
      }
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
      if (!requireLocalMaintenanceMutation()) return;
      const sessionId = maintenanceSettingsRoute.sessionId;
      if (!isSafeOpaqueId(sessionId)) return json(res, { error: 'sessionId 非法', code: 'session-id-invalid' }, 400);
      const body = await readBody(req);
      if (Object.keys(body).some((key) => key !== 'enabled') || typeof body.enabled !== 'boolean') {
        return json(res, { error: 'maintenance settings 请求非法', code: 'maintenance-settings-invalid' }, 400);
      }
          if (!(await loadSessionById(sessionId))) {
        return json(res, { error: '会话不存在', code: 'session-not-found' }, 404);
      }
      maintenanceHarness!.setSessionEnabled(sessionId, body.enabled);
      return json(res, { settings: maintenanceHarness!.settings(sessionId) });
    }

    const maintenanceCreateRoute = matchRouteTemplate('/api/session/:sessionId/maintenance-jobs', p);
    if (method === 'POST' && maintenanceCreateRoute) {
      if (!requireLocalMaintenanceMutation()) return;
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
              },
              409,
          );
      }

      // Same account-wide read scope as /api/events, but only validated task metadata.
      // A caller cannot use this endpoint to resolve refs, goals or domain bodies.
      if (method === 'GET' && p === '/api/agent-loop/task-status') {
          res.setHeader('Cache-Control', 'no-store');
          if (
              url.searchParams.getAll('taskId').length !== 1 ||
              url.searchParams.getAll('outcomes').length > 1 ||
              url.searchParams.getAll('explain').length > 1 ||
              (url.searchParams.has('explain') && (url.searchParams.get('explain') !== '1' || url.searchParams.has('outcomes'))) ||
              (url.searchParams.has('outcomes') && url.searchParams.get('outcomes') !== '1') ||
              [...url.searchParams.keys()].some((key) => key !== 'taskId' && key !== 'outcomes' && key !== 'explain')
          ) {
              return json(res, { code: 'agent-loop-task-id-invalid' }, 400);
          }
          try {
              const taskId = url.searchParams.get('taskId');
              const status = url.searchParams.has('outcomes')
                  ? readAgentLoopTaskOutcomeStatus(AGENT_LOOP_PROJECTION_STORE, taskId, AGENT_LOOP_SUMMARY_APPLY_OUTCOME_READER)
                  : url.searchParams.has('explain') ? readAgentLoopTaskExplanation(AGENT_LOOP_PROJECTION_STORE, taskId)
                  : readAgentLoopTaskStatus(AGENT_LOOP_PROJECTION_STORE, taskId);
              if (!status) return json(res, { code: 'agent-loop-task-not-found' }, 404);
              return json(res, status);
          } catch (error) {
              if (error instanceof Error && error.message === 'agent-loop-task-id-invalid') {
                  return json(res, { code: 'agent-loop-task-id-invalid' }, 400);
              }
              return json(res, { code: 'agent-loop-task-status-unavailable' }, 503);
          }
    }

    // -----------------------------------------------------------------
    // P7-05/06：失效通知 SSE。中央管线已完成认证/scope/Origin/连接预算；
    // routeAccess.stream=true 已把连接登记进 AUTH_STREAMS（吊销即终止）。
    // 事件只触发 refetch：有界 replay（P7-06）只补最近缓冲内的连续区间，
    // 任何缺口/跨实例/超前游标都回 sync.required；REST/SQLite 仍是唯一真值。
    // -----------------------------------------------------------------
    if (method === 'GET' && p === '/api/events') {
      const taskEventVersion = req.headers['x-jg-task-event-version'];
      if (taskEventVersion !== undefined && taskEventVersion !== '2') {
        return json(res, { code: 'task-event-version-invalid' }, 400);
      }
      const taskEventsV2 = taskEventVersion === '2';
      const endTaskEventError = () => {
        try {
          res.write('event: task-event.error\ndata: {"code":"task-event-evidence-unavailable"}\n\n');
          res.end();
        } catch { res.destroy(); }
      };
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
            let projected: EventEnvelope;
            try { projected = eventHub.taskEventForClient(envelope, taskEventsV2); }
            catch { endTaskEventError(); return; }
            res.write(
              `id: ${projected.eventId}\nevent: ${projected.type}\ndata: ${JSON.stringify(projected)}\n\n`,
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
        let projected: EventEnvelope;
        try { projected = eventHub.taskEventForClient(envelope, taskEventsV2); }
        catch { endTaskEventError(); return; }
        try {
          res.write(
            `id: ${projected.eventId}\nevent: ${projected.type}\ndata: ${JSON.stringify(projected)}\n\n`,
          );
        } catch { res.destroy(); }
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
      if (isSafeOpaqueId(sessionId, 160) && !sessionDeletionAdmissionOpen(sessionId)) {
        return json(res, { error: '会话正在删除', code: 'session-deleting' }, 409);
      }
      const session = sessions.get(sessionId);
      if (!session) return json(res, { error: '会话不存在，请先创建或恢复' }, 404);
      const input = String(body.input ?? '').trim();
      let attachments: ImageAttachment[];
      let branchSelection: BranchSelectionReference | undefined;
      let nsfwState: unknown;
      try {
        attachments = parseImageAttachments(body.attachments);
        branchSelection = parseBranchSelection(body.branchSelection);
        nsfwState = parseNsfwAgentStatePayload(body.nsfw_state);
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
      if (!input && attachments.length === 0) return json(res, { error: '输入为空' }, 400);
          const compatibilityRunId =
              body.runId === undefined ? `legacy-${requestId}` : isSafeOpaqueId(body.runId) ? body.runId : undefined;
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
          ...(nsfwState === undefined ? {} : { nsfwState }),
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
      const unsubscribeProgress = turnJobs.subscribeProgress(created.job.runId, progress => {
        sseSend(res, { type: 'progress', ...progress });
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
            // succeeded turn 已原子提交 memory/meta/state；人物通知为空不等于“没有提交”。
            type: 'memory', committed: true,
            characters: charNotices, headVersion: session.memoryHeadVersion(),
            pending: session.getCharacterPending(), pool: session.getCharacterPool(),
            changedDomains: ['memory', 'turn-state', ...(charNotices.length > 0 ? ['characters'] : [])],
            turnState: session.getTurnState(),
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
        unsubscribeProgress();
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
          const compatibilityRunId =
              body.runId === undefined ? `legacy-${requestId}` : isSafeOpaqueId(body.runId) ? body.runId : undefined;
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
      const unsubscribeProgress = turnJobs.subscribeProgress(created.job.runId, progress => {
        sseSend(res, { type: 'progress', ...progress });
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
        unsubscribeProgress();
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
        STYLE_COMPILE_RUNTIME?.wakeSession(id);
        scheduleLearningDrain(session);
        return json(res, { ok: true, round: r.round, mode });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      } finally {
        // Only existing original markers are read; optional post-commit failures cannot hide a completed rollback.
        try { scheduleVariableInvalidationEvidence(id); }
        catch { console.warn('[AgentEvidence] VARIABLE_INVALIDATION_DELIVERY_PENDING'); }
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
              const parsed = parseStoryIndexPostBody((await readBody(req)) as unknown);
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
      const durableDeletion = SESSION_DELETION_JOURNAL.get(id);
      const existedBefore = existsSync(dbPath);
      if (!existedBefore && !durableDeletion) {
        // CAS 删除的竞争失败必须暴露当前真值 absent；否则第二个客户端只看到普通 404，
        // 无法区分“从未存在”与“基于旧 revision 的并发删除”。
        if (expected !== ABSENT_REVISION) {
          return revisionConflict(res, expected, ABSENT_REVISION, `session:${id}`);
        }
        return json(res, { error: '会话不存在' }, 404);
      }
      if (!durableDeletion) {
        const session = sessions.get(id);
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
      }
      if (expected === ABSENT_REVISION) {
        return revisionConflict(
          res,
          expected,
          durableDeletion?.sourceRevision ?? ABSENT_REVISION,
          `session:${id}`,
        );
      }
      const operationId = `sdelete:${createHash('sha256')
        .update(`${id.length}:${id}:${expected}`)
        .digest('hex')}`;
      try {
        const result = await SESSION_DELETION_COORDINATOR.deleteSession({
          sessionId: id,
          operationId,
          sourceRevision: expected,
        });
        if (result.status === 'conflict') {
          return revisionConflict(res, expected, result.actualRevision, `session:${id}`);
        }
        if (result.status === 'accepted') {
          return revisionJson(res, {
            ok: false,
            pending: true,
            id,
            code: result.errorCode,
            snapshotToken: ABSENT_REVISION,
          }, ABSENT_REVISION, 202);
        }
      } catch (error) {
        const code = (error as Error).message === 'session-deletion-reservation-conflict'
          ? 'session-delete-in-progress' : 'session-delete-failed';
        return json(res, {
          error: {
            code,
            message: code === 'session-delete-in-progress'
              ? '会话删除正在收口，请稍后重试'
              : '会话删除未能安全进入清理流程，请稍后重试',
          },
        }, code === 'session-delete-in-progress' ? 409 : 503);
      }
      eventHub.publish({
        type: 'session.deleted',
        resource: { kind: 'session', id, revision: ABSENT_REVISION },
        requestId,
      });
      return revisionJson(res, {
        ok: true,
        removed: existedBefore,
        id,
        snapshotToken: ABSENT_REVISION,
      }, ABSENT_REVISION);
    }

      const agentControlMutationAccess = (): ReturnType<typeof authorizeAgentControlMutation> =>
      authorizeAgentControlMutation({
        runtime: AGENT_CONTROL_MUTATION_RUNTIME,
        authority: authority.authority,
        localAuthorities: LOCAL_AUTHORITIES,
        accessMode: ACCESS_MODE,
        authenticatedAdmin: authenticatedContext?.isAdmin === true,
          });

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
            if (!sessionDeletionAdmissionOpen(proposal.sessionId)) {
              throw new Error('maintenance-proposal-session-deleting');
            }
            const proposalSession = await loadSessionById(proposal.sessionId);
            if (!proposalSession) throw new Error('maintenance-proposal-session-not-found');
            if (!sessionDeletionAdmissionOpen(proposal.sessionId)) {
              throw new Error('maintenance-proposal-session-deleting');
            }
            // Always pass through the typed control so a session-DB write that committed
            // just before a control-DB crash is recovered as applied, never hidden as rejected.
            const control = maintenanceProposalControlFor(proposal.sessionId, proposalSession).reject(
              mutation.proposalId,
              mutation.expectedRevision,
              mutation.reasonCode,
            );
            if ((proposal.taskKind === 'memory_consolidation' || proposal.taskKind === 'rolling_summary')
              && control.status === 'applied') {
              eventHub.publish({
                type: 'session.updated',
                resource: {
                  kind: 'session', id: proposal.sessionId,
                  revision: snapshotForSession(proposalSession).snapshotToken,
                },
                requestId,
                runId: proposal.jobRunId,
                data: { status: `maintenance-${proposal.taskKind}-applied` },
              });
            }
            securityAuditSpan?.annotate({ reasonCode: `maintenance-proposal-${control.status}` });
            return json(res, { ok: true, control });
          }
          if (mutation.operation === 'approve-maintenance-proposal'
            && !maintenanceProposalApplySupported(
              MAINTENANCE_APPLY_RUNTIME,
              proposal.sessionId,
              proposal.taskKind,
            )) {
            throw new Error('maintenance-proposal-apply-disabled');
          }
          const proposalSession = await loadSessionById(proposal.sessionId);
          if (!proposalSession) throw new Error('maintenance-proposal-session-not-found');
          if (!sessionDeletionAdmissionOpen(proposal.sessionId)) {
            throw new Error('maintenance-proposal-session-deleting');
          }
          const control = maintenanceProposalControlFor(proposal.sessionId, proposalSession);
          if (mutation.operation === 'approve-maintenance-proposal') {
            const reviewItems = maintenanceProposalReviewItems(proposal, proposalSession);
            if (!reviewItems?.length) throw new Error('maintenance-proposal-review-required');
            if (!maintenanceReviewHasApplicableWrite(reviewItems)) {
              throw new Error('maintenance-proposal-no-applicable-write');
            }
          }
          const updated = mutation.operation === 'approve-maintenance-proposal'
            ? control.approve(mutation.proposalId, mutation.expectedRevision)
            : control.rollback(mutation.proposalId, mutation.expectedRevision);
          if ((proposal.taskKind === 'memory_consolidation' || proposal.taskKind === 'rolling_summary')
            && (updated.status === 'applied' || updated.status === 'rolled_back')) {
            eventHub.publish({
              type: 'session.updated',
              resource: {
                kind: 'session', id: proposal.sessionId,
                revision: snapshotForSession(proposalSession).snapshotToken,
              },
              requestId,
              runId: proposal.jobRunId,
              data: { status: `maintenance-${proposal.taskKind}-${updated.status}` },
            });
          }
          securityAuditSpan?.annotate({ reasonCode: `maintenance-proposal-${updated.status}` });
          return json(res, { ok: true, control: updated });
        }
        if (mutation.operation === 'clear-preference-profile') {
          if (!sessionDeletionAdmissionOpen(mutation.sessionId)) {
            throw new Error('preference-profile-session-deleting');
          }
          const session = await loadSessionById(mutation.sessionId);
          if (!session) {
            return dshJson(res, {
              error: '会话不存在', code: 'preference-profile-session-not-found', requestId,
            }, 404);
          }
          if (!sessionDeletionAdmissionOpen(mutation.sessionId)) {
            throw new Error('preference-profile-session-deleting');
          }
          const control = session.clearPreferenceProfiles({
            expectedRevision: mutation.expectedRevision,
            operationId: mutation.operationId,
          });
          LEARNING_PREFERENCE_SOURCE_SCHEDULER?.schedule(mutation.sessionId);
          EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER?.schedule(mutation.sessionId);
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
        // P16 C2.3：Style 提案的转换证据（写后回读在 observeStyleCompileControl 内部）。
        // 业务转换已提交，观测失败不得影响响应。
        if (mutation.operation === 'approve-style-proposal') {
          observeStyleCompileControl(control as StyleProposal, 'applied');
        } else if (mutation.operation === 'rollback-style-proposal') {
          observeStyleCompileControl(control as StyleProposal, 'reverted');
        } else if (mutation.operation === 'disable-style-proposal') {
          observeStyleCompileControl(control as StyleProposal, 'disabled');
        }
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
          || code === 'maintenance-proposal-review-required'
          || code === 'maintenance-proposal-no-applicable-write'
          || code === 'maintenance-proposal-source-revision-stale'
          || code === 'maintenance-proposal-session-deleting'
          || code === 'preference-profile-session-deleting'
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
                || code === 'known-defect-correction-already-applied'
                || code === 'known-defect-kill-signature-mismatch'
                || code === 'known-defect-observation-signature-mismatch'
                || code === 'known-defect-other-permanent-evidence-present'
                || code === 'known-defect-window-not-quiescent'
                || code === 'known-defect-evidence-missing'
                || code === 'known-defect-evidence-not-operational'
                || code === 'known-defect-evidence-stale-recorded-at'
                || code === 'known-defect-evidence-stale-captured-at'
                || code === 'capability-quality-recovery-required'
                || code === 'capability-kill-reason-conflict'
                || code === 'capability-not-killed'
                || code === 'style-proposal-already-disabled'
                || code === 'style-proposal-already-enabled'
                || code === 'style-proposal-not-enabled'
                || code === 'style-proposal-rollback-version-invalid'
                || code === 'agent-control-noop' ? 409 : 400;
        const publicCode = /^agent-control-[a-z-]+$|^lane-[a-z-]+$|^known-defect-[a-z-]+$|^capability-[a-z-]+$|^style-proposal-[a-z-]+$|^learning-preference-[a-z-]+$|^preference-profile-[a-z-]+$|^maintenance-proposal-[a-z-]+$|^npc-maintenance-[a-z-]+$|^worldbook-repair-[a-z-]+$/u.test(code)
          ? code : 'agent-control-mutation-failed';
        securityAuditSpan?.annotate({ reasonCode: publicCode });
        return dshJson(res, { error: 'Agent 控制操作未应用', code: publicCode, requestId }, status);
      }
    }

    // P15-C：NSFW 场景策展的可信安全控制面。secured 模式由 route manifest
    // 强制 admin + CSRF；local-only 模式仍受 loopback authority 约束。服务端只接受
    // 当前会话实际加载的世界书，并把声明绑定到其 sourceRevision。浏览器 localStorage
    // 和模型生成内容都不参与授权。
    const nsfwSceneSafetyRoute = matchRouteTemplate('/api/session/:sessionId/nsfw-scene-safety', p);
    if ((method === 'GET' || method === 'POST') && nsfwSceneSafetyRoute) {
      const id = nsfwSceneSafetyRoute.sessionId;
      if (!isSafeOpaqueId(id)) {
        return json(res, { error: 'sessionId 非法', code: 'session-id-invalid' }, 400);
      }
      const dbPath = resolveSessionDatabase(DATA_DIR, `${id}.db`);
      if (!dbPath || !existsSync(dbPath)) {
        return json(res, { error: '会话不存在', code: 'session-not-found' }, 404);
      }
          const session = sessions.get(id) ?? (await loadSessionById(id));
      if (!session) return json(res, { error: '会话不存在', code: 'session-not-found' }, 404);
      const manifest = session.getWorldbookSourceManifest();
      try {
        let turnAbort: ReturnType<ChatSession['abortActiveTurn']> | null = null;
        let safety;
        if (method === 'GET') {
          safety = NSFW_SCENE_SAFETY_CONTROL.read({ dbPath, sessionId: id, manifest });
        } else {
          const update = parseNsfwSceneSafetyUpdate(await readBody(req));
          safety = NSFW_SCENE_SAFETY_CONTROL.update({
            dbPath,
            sessionId: id,
            manifest,
            request: update,
          });
          // Withdrawal is safety-dominant: stop an already assembled/in-flight
          // turn as well as closing the gate for every subsequent turn.
          if (!safety.enabled) {
            const activeJob = turnJobs.getActiveForSession(id);
            if (activeJob) {
              try { turnJobs.cancel(activeJob.runId); } catch { /* resolver is already revoked */ }
            }
            const activeTurn = session.getActiveTurnState();
            if (activeTurn.active) turnAbort = session.abortActiveTurn(activeTurn.runId, activeTurn.round);
          }
          await CONTEXT_COMPILER_SHADOW_RUNNER.cancelSession(id);
          if (DIRECTOR_CREATIVE_SERVICE) {
            try { await DIRECTOR_CREATIVE_SERVICE.quiesceSession(id); }
            finally { DIRECTOR_CREATIVE_SERVICE.releaseQuiescence(id); }
          }
          // Remember the attestation device-wide, including revocations: a withdrawn consent
          // must not be inherited by the next new session.
          try {
            NSFW_SCENE_ATTESTATION_MEMORY.record({
              adultAttestation: update.adultAttestation,
              participantsAdult: update.participantsAdult,
              consent: update.consent,
              allowedWorldbooks: safety.allowedWorldbooks,
            });
          } catch (memoryError) {
            console.warn('[NsfwSafety] 电脑级授权记忆写入失败（仅影响新会话预填）:',
              memoryError instanceof Error ? memoryError.message : memoryError);
          }
        }
        securityAuditSpan?.annotate({ reasonCode: method === 'GET'
          ? 'nsfw-safety-read-ok'
          : safety.enabled ? 'nsfw-safety-enabled' : 'nsfw-safety-revoked' });
        return json(res, {
          safety,
          manifest: { books: [...manifest.books], sourceRevision: manifest.sourceRevision },
          // A brand-new session pre-fills its grant form from the device-level attestation; this
          // is a pre-fill only — enabling still requires the explicit POST below.
          ...(method === 'GET' && safety.reasonCode === 'not-configured'
            ? { inheritedAttestation: NSFW_SCENE_ATTESTATION_MEMORY.readLatest() }
            : {}),
          ...(turnAbort ? { turnAbort } : {}),
        });
      } catch (error) {
        if (error instanceof PayloadTooLargeError || error instanceof BodyDeadlineError) throw error;
        const code = error instanceof NsfwSceneSafetyControlError
          ? error.code
          : error instanceof SyntaxError ? 'nsfw-safety-request-invalid'
            : 'nsfw-safety-storage-failed';
        const status = code === 'nsfw-safety-revision-conflict' ? 409
          : code === 'nsfw-safety-storage-invalid' || code === 'nsfw-safety-storage-failed' ? 503
            : 400;
        securityAuditSpan?.annotate({ reasonCode: code });
        return json(res, {
          error: status === 409 ? '安全声明已被其他操作更新，请刷新后重试'
            : status === 503 ? '安全声明暂时不可用，场景策展保持关闭'
              : 'NSFW 场景安全设置无效',
          code,
        }, status);
      }
    }

    // 会话 Agent 状态
    const agentControlGetRoute = matchRouteTemplate('/api/session/:sessionId/agent-control', p);
    if (method === 'GET' && agentControlGetRoute) {
      const id = agentControlGetRoute.sessionId;
      const dbPath = resolveSessionDatabase(DATA_DIR, `${id}.db`);
      if (!dbPath || !existsSync(dbPath)) return json(res, { error: '会话不存在' }, 404);
      const mutationAccess = agentControlMutationAccess();
      let styleAdoptionEvidence: ReturnType<typeof readStyleCompileAdoptionEvidencePage> = null;
      let styleEvidenceCursor = 0, styleEvidenceLimit = 10;
      let variableApplyEvidence: ReturnType<typeof readVariableApplyEvidencePage> | ReturnType<typeof readVariableApplyEvidencePageV2> = null;
      let variableEvidenceVersion = 1;
      let variableEvidenceCursor = 0, variableEvidenceLimit = 10;
      if (url.searchParams.has('styleEvidence') || url.searchParams.has('styleEvidenceCursor')
          || url.searchParams.has('styleEvidenceLimit')) {
        res.setHeader('Cache-Control', 'no-store');
        const cursorText = url.searchParams.get('styleEvidenceCursor') ?? '0';
        const limitText = url.searchParams.get('styleEvidenceLimit') ?? '10';
        if (url.searchParams.getAll('styleEvidence').length !== 1 || url.searchParams.get('styleEvidence') !== '1'
            || url.searchParams.getAll('styleEvidenceCursor').length > 1 || url.searchParams.getAll('styleEvidenceLimit').length > 1
            || !/^(0|[1-9][0-9]{0,15})$/u.test(cursorText) || !/^[1-9][0-9]?$/u.test(limitText)
            || !Number.isSafeInteger(Number(cursorText)) || Number(limitText) > 10) {
          return json(res, { code: 'style-evidence-page-invalid' }, 400);
        }
        if (!mutationAccess.allowed) return json(res, { code: 'style-evidence-forbidden' }, 403);
        if (!sessionDeletionAdmissionOpen(id)) return json(res, { code: 'session-not-found' }, 404);
        if (!AGENT_EVIDENCE_LEDGER) return json(res, { code: 'style-evidence-unavailable' }, 503);
        try {
          styleEvidenceCursor = Number(cursorText); styleEvidenceLimit = Number(limitText);
          styleAdoptionEvidence = readStyleCompileAdoptionEvidencePage({ path: dbPath, rawSessionId: id,
            ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
            cursor: styleEvidenceCursor, limit: styleEvidenceLimit });
          if (!styleAdoptionEvidence) return json(res, { code: 'style-evidence-unavailable' }, 503);
        } catch { return json(res, { code: 'style-evidence-unavailable' }, 503); }
      }
      if (url.searchParams.has('variableEvidence') || url.searchParams.has('variableEvidenceCursor')
          || url.searchParams.has('variableEvidenceLimit')) {
        res.setHeader('Cache-Control', 'no-store');
        const cursorText = url.searchParams.get('variableEvidenceCursor') ?? '0';
        const limitText = url.searchParams.get('variableEvidenceLimit') ?? '10';
        if (url.searchParams.getAll('variableEvidence').length !== 1 || !['1', '2'].includes(url.searchParams.get('variableEvidence') ?? '')
            || url.searchParams.getAll('variableEvidenceCursor').length > 1 || url.searchParams.getAll('variableEvidenceLimit').length > 1
            || !/^(0|[1-9][0-9]{0,15})$/u.test(cursorText) || !/^[1-9][0-9]?$/u.test(limitText)
            || !Number.isSafeInteger(Number(cursorText)) || Number(limitText) > 10)
          return json(res, { code: 'variable-evidence-page-invalid' }, 400);
        if (!mutationAccess.allowed) return json(res, { code: 'variable-evidence-forbidden' }, 403);
        if (!sessionDeletionAdmissionOpen(id)) return json(res, { code: 'session-not-found' }, 404);
        if (!AGENT_EVIDENCE_LEDGER) return json(res, { code: 'variable-evidence-unavailable' }, 503);
        try {
          variableEvidenceCursor = Number(cursorText); variableEvidenceLimit = Number(limitText);
          variableEvidenceVersion = Number(url.searchParams.get('variableEvidence'));
          variableApplyEvidence = (variableEvidenceVersion === 2 ? readVariableApplyEvidencePageV2 : readVariableApplyEvidencePage)({ path: dbPath, rawSessionId: id,
            ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
            cursor: variableEvidenceCursor, limit: variableEvidenceLimit });
          if (!variableApplyEvidence) return json(res, { code: 'variable-evidence-unavailable' }, 503);
        } catch { return json(res, { code: 'variable-evidence-unavailable' }, 503); }
      }
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
      const agentControlNow = new Date();
      let contextCompilerCanaryAllowed = false;
      try { contextCompilerCanaryAllowed = CONTEXT_COMPILER_RUNTIME.mode === 'canary'
        && contextCompilerRuntimeAllows(parseContextCompilerRuntimeConfig(process.env), id); } catch { /* report disabled */ }
      const agentControl = readSessionAgentControl({
        rawSessionId: id,
        opaqueSessionId,
        controlStore: AGENT_CONTROL_STORE,
        admissionLedger: AGENT_ADMISSION_LEDGER,
        contextCompilerCanaryAllowed,
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
        now: agentControlNow,
        maintenanceSettings: maintenanceJobs.settings(id),
        // Exact-session, content-free scheduler diagnostics. The read composer
        // applies the same rolling-budget helper used by admission so the UI
        // cannot drift from the actual gate.
        maintenanceJobs: maintenanceJobs.listAdmissionBudgetWindow(id, agentControlNow.getTime()),
        // Shadow proposal execution is intentionally independent from any
        // pre-existing apply backup marker. The read model derives NPC proposal
        // availability from the Maintenance lane/capability gates only.
        maintenanceApplyActivationSessions: NPC_MAINTENANCE_ACTIVATION_SESSIONS,
        maintenanceProposals: maintenanceJobs.listPendingProposals(id).map((proposal) => {
          const pending = mutationAccess.allowed
            ? maintenanceJobs.getPendingProposal(proposal.proposalId)
            : undefined;
          const reviewItems = pending
            ? maintenanceProposalReviewItems(pending, loadedSession)
            : undefined;
          return {
            id: proposal.proposalId,
            taskKind: proposal.taskKind,
            status: proposal.status,
            proposalDigest: proposal.proposalDigest,
            itemCount: proposal.taskKind === 'rolling_summary'
              ? 1 : Number(proposal.diff.itemCount ?? 0),
            revision: proposal.revision,
            applySupported: maintenanceProposalApplySupported(
              MAINTENANCE_APPLY_RUNTIME,
              id,
              proposal.taskKind,
            ),
            ...(reviewItems ? { reviewItems } : {}),
            createdAt: proposal.createdAt,
            updatedAt: proposal.updatedAt,
          };
        }),
        // 变更审阅视图只给本机可操作者（与 canApprove 同一权限源）；
        // 远端只读客户端拿到的是不含内容的摘要。
        worldbookRepairProposals: WORLDBOOK_REPAIR_CONTROL_PLANE?.list(id, 50, mutationAccess.allowed)
          ?? Object.freeze([]),
      });
      if (styleAdoptionEvidence || variableApplyEvidence) {
        if (!sessionDeletionAdmissionOpen(id) || !agentControlMutationAccess().allowed)
          return json(res, { code: styleAdoptionEvidence ? 'style-evidence-forbidden' : 'variable-evidence-forbidden' }, 403);
        try {
          if (styleAdoptionEvidence && (!AGENT_EVIDENCE_LEDGER || JSON.stringify(readStyleCompileAdoptionEvidencePage({ path: dbPath,
            rawSessionId: id, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
            cursor: styleEvidenceCursor, limit: styleEvidenceLimit })) !== JSON.stringify(styleAdoptionEvidence)))
            return json(res, { code: 'style-evidence-unavailable' }, 503);
        } catch { return json(res, { code: 'style-evidence-unavailable' }, 503); }
        try {
          if (variableApplyEvidence && (!AGENT_EVIDENCE_LEDGER || JSON.stringify((variableEvidenceVersion === 2 ? readVariableApplyEvidencePageV2 : readVariableApplyEvidencePage)({ path: dbPath,
            rawSessionId: id, ledger: AGENT_EVIDENCE_LEDGER, allowed: sessionDeletionAdmissionOpen,
            cursor: variableEvidenceCursor, limit: variableEvidenceLimit })) !== JSON.stringify(variableApplyEvidence)))
            return json(res, { code: 'variable-evidence-unavailable' }, 503);
        } catch { return json(res, { code: 'variable-evidence-unavailable' }, 503); }
        if (!sessionDeletionAdmissionOpen(id) || !agentControlMutationAccess().allowed)
          return json(res, { code: styleAdoptionEvidence ? 'style-evidence-forbidden' : 'variable-evidence-forbidden' }, 403);
        return json(res, { ...agentControl, ...(styleAdoptionEvidence ? { styleAdoptionEvidence } : {}),
          ...(variableApplyEvidence ? { variableApplyEvidence } : {}) });
      }
      return json(res, agentControl);
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
          const session = sessions.get(id) ?? (await loadSessionById(id));
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const snapshot = snapshotForSession(session);
      return revisionJson(res, {
        snapshotToken: snapshot.snapshotToken,
        databaseRevision: snapshot.databaseRevision,
        rowCounts: snapshot.rowCounts,
        assets: snapshot.assets,
      }, snapshot.snapshotToken);
    }

    // Content-addressed tool bodies remain bound to the current Session's own mode and epoch.
    const toolResultBodyPostRoute = matchRouteTemplate('/api/session/:sessionId/tool-result-body', p);
    if (method === 'POST' && toolResultBodyPostRoute) {
      const id = toolResultBodyPostRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      if (shuttingDown || !sessionDeletionAdmissionOpen(id)) {
        return json(res, { error: '会话不可访问', code: 'session-unavailable' }, 409);
      }
      const request = parseToolResultBodyRead(await readBody(req));
      if (!request) return json(res, { error: '工具正文读取参数非法', code: 'invalid-tool-result-body-read' }, 400);
      if (shuttingDown || sessions.get(id) !== session || !sessionDeletionAdmissionOpen(id)) {
        return json(res, { error: '会话不可访问', code: 'session-unavailable' }, 409);
      }
      try {
        return json(res, session.readToolResultBody(request));
      } catch (error) {
        if (error instanceof Error && error.message === 'tool-result-body-unavailable') {
          return json(res, { error: '工具正文不可读取', code: 'tool-result-body-unavailable' }, 404);
        }
        throw error;
      }
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

    const turnAgentEvidenceRoute = matchRouteTemplate('/api/session/:sessionId/turn-agent-evidence', p);
    if (method === 'GET' && turnAgentEvidenceRoute) {
      res.setHeader('Cache-Control', 'no-store');
      const id = turnAgentEvidenceRoute.sessionId;
      const session = sessions.get(id);
      if (!session || !sessionDeletionAdmissionOpen(id)) return json(res, { code: 'session-not-found' }, 404);
      if (!AGENT_CLOSURE_STORE) return json(res, { code: 'turn-agent-evidence-unavailable' }, 503);
      try {
        const evidence = readCurrentTurnAgentEvidence({ sessionId: id, session, closure: AGENT_CLOSURE_STORE,
          styleJobs: STYLE_COMPILE_RUNTIME,
          allowed: () => sessions.get(id) === session && sessionDeletionAdmissionOpen(id) });
        return json(res, { evidence });
      } catch (error) {
        const stale = error instanceof Error && error.message === 'turn-agent-evidence-stale';
        return json(res, { code: stale ? 'turn-agent-evidence-stale' : 'turn-agent-evidence-unavailable' }, stale ? 409 : 503);
      }
    }

    // 推进槽 / 事件类型 / NSFW 锁定（P2）
    const turnStateGetRoute = matchRouteTemplate('/api/session/:sessionId/turn-state', p);
    if (method === 'GET' && turnStateGetRoute) {
      const id = turnStateGetRoute.sessionId;
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const progress = turnJobs.progressForSession(id);
      return json(res, { state: session.getTurnState(), generation: session.getActiveTurnState(),
        headVersion: session.memoryHeadVersion(), ...(progress ? { progress } : {}) });
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
              const replaced = session.replaceMvuState(state as Record<string, unknown>, ref, {
                  ...opts,
                  expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
              });
              if (!replaced.ok)
                  return json(
                      res,
                      { error: replaced.error, code: replaced.code },
                      replaced.code === 'unresolved' ? 404 : 409,
        );
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
          const changed = Array.isArray(body.changed) ? (body.changed as TavernHelperEntry[]) : [];
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
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = saveUserAssetCas('worldbook', file, JSON.stringify(parsed, null, 2), expected);
          const identity = ensureAssetIdentityInMutation('worldbook', file);
          return { mutation, identity };
        });
        const { entries } = rawEntriesOf(parsed);
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

    // ── Agent Provider 独立路由（只保存 mode/providerId/model；继承模式实时跟随主选择）──
    if (method === 'GET' && p === '/api/agent-provider') {
      try {
        // P16 T-1：凭据封锁（测试安全门）下不得读取 agent-provider.json。
        const config = loadAgentProviderConfig({ ignoreFile: credentialLockdownActive() });
        const main = loadProviderConfig();
        const effective = config.mode === 'inherit-main'
          ? { providerId: main.providerId, model: main.model }
          : { providerId: config.providerId, model: config.model };
        const descriptor = providerRegistry.describe(effective.providerId);
        return json(res, {
          ok: true,
          mode: config.mode,
          ...(config.mode === 'override'
            ? { providerId: config.providerId, model: config.model }
            : {}),
          effectiveProviderId: effective.providerId,
          effectiveModel: effective.model,
          available: descriptor?.configured === true,
          ...(descriptor ? { provider: descriptor } : {}),
        });
      } catch (error) {
        if (error instanceof AgentProviderConfigFileError) {
          return json(res, { ok: false, code: 'agent-provider-config-invalid', error: error.message }, 409);
        }
        throw error;
      }
    }

    if (method === 'POST' && p === '/api/agent-provider') {
      if (!PROVIDER_SPI_ENABLED) {
        return json(res, {
          ok: false,
          code: 'provider-spi-disabled',
          error: 'Provider SPI 已由 JG_PROVIDER_SPI=0 关闭',
        }, 409);
      }
      const body = await readBody(req);
      const allowedKeys = new Set(['mode', 'providerId', 'model']);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
        return json(res, { ok: false, code: 'invalid-agent-provider', error: 'Agent Provider 配置包含未知字段' }, 400);
      }
      let config: AgentProviderConfig;
      try {
        config = normalizeAgentProviderConfig(body);
      } catch {
        return json(res, { ok: false, code: 'invalid-agent-provider', error: 'Agent Provider 配置非法' }, 400);
      }
      if (config.mode === 'override') {
        const descriptor = providerRegistry.describe(config.providerId);
        if (!descriptor) {
          return json(res, {
            ok: false,
            code: 'not-found',
            error: `Provider 不可用: ${config.providerId}`,
          }, 404);
        }
        if (!descriptor.configured) {
          return json(res, {
            ok: false,
            code: 'not-configured',
            error: `Provider 未配置: ${config.providerId}`,
          }, 409);
        }
      }
      writeAgentProviderConfig(config);
      const main = loadProviderConfig();
      const effective = config.mode === 'inherit-main'
        ? { providerId: main.providerId, model: main.model }
        : { providerId: config.providerId, model: config.model };
      const descriptor = providerRegistry.describe(effective.providerId);
      return json(res, {
        ok: true,
        mode: config.mode,
        ...(config.mode === 'override'
          ? { providerId: config.providerId, model: config.model }
          : {}),
        effectiveProviderId: effective.providerId,
        effectiveModel: effective.model,
        available: descriptor?.configured === true,
        ...(descriptor ? { provider: descriptor } : {}),
      });
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

    // 服务端代理抓取外部前端页文本（如卡自带 sample-phone-host/index.html；浏览器 fetch 跨域受限，由服务器侧解决 CORS）
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
      if (isSafeOpaqueId(sid, 160) && !sessionDeletionAdmissionOpen(sid)) {
        return json(res, { error: '会话正在删除，暂时拒绝访问', code: 'session-deleting' }, 409);
      }
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
          const rule = body.rule && typeof body.rule === 'object' ? (body.rule as Record<string, unknown>) : null;
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
        const mutation = AGENT_CONTROL_STORE.withAssetMutation(
          () => ASSET_IMPORT_TRANSACTIONS.commit(prepared),
        );
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
      const filename = (body.filename ?? '').toString();
      const format = body.format === 'png' ? 'png' : 'json';
      const data = (body.data ?? '').toString();
      if (!filename.trim()) return json(res, { error: '缺少文件名' }, 400);
      if (!isSafeAssetFileName(filename)) return json(res, { error: '文件名非法' }, 400);
      if (!data || data.length > MAX_IMPORT) return json(res, { error: '文件过大或为空' }, 400);
      const name = filename.replace(/\.(json|png)$/i, '');
      if (!name) return json(res, { error: '文件名非法' }, 400);
      const jsonFile = `${name}.json`;
      const pngFile = `${name}.png`;
      if (!isSafeAssetFileName(jsonFile)
        || (format === 'png' && !isSafeAssetFileName(pngFile))) {
        return json(res, { error: '文件名非法' }, 400);
      }
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
      let committed: {
        mutation: ReturnType<typeof saveUserAssetCas>;
        identity: LocalAssetIdentity;
        pngSaved: boolean;
      };
      try {
        committed = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = saveUserAssetCas('card', jsonFile, cardJson, expected);
          let pngSaved = false;
          if (pngBuf) {
            try {
              saveAssetBuffer('card', pngFile, pngBuf);
              pngSaved = true;
                      } catch {
                          /* 规范 JSON 已是完整业务真值；PNG 原件失败不回滚卡片 */
          }
                  }
                  const identity = ensureAssetIdentityInMutation('card', jsonFile, parsedCard.card.name || name);
          return { mutation, identity, pngSaved };
        });
      } catch (error) {
        if (assetConflict(res, error)) return;
        throw error;
      }
      const { mutation, identity, pngSaved } = committed;
      sessionCardFileCache.clear();
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
      let committed: {
        mutation: ReturnType<typeof saveUserAssetCas>;
        identity: LocalAssetIdentity;
      };
      try {
        const worldbookRaw = JSON.stringify({ name: wbName, entries: wbEntries }, null, 2);
        parseWorldBook(worldbookRaw); // 强校验后再落盘
        committed = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = saveUserAssetCas('worldbook', wbFile, worldbookRaw, expected);
          const identity = ensureAssetIdentityInMutation('worldbook', wbFile, wbName);
          return { mutation, identity };
        });
      } catch (e) {
        if (assetConflict(res, e)) return;
        return json(res, { error: `世界书生成失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      const { mutation, identity } = committed;
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
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = deleteUserCardCas(file, expected);
          const identity = ensureAssetIdentityInMutation('card', file);
          return { mutation, identity };
        });
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
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = saveUserAssetCas('preset', filename, raw, expected);
          const identity = ensureAssetIdentityInMutation('preset', filename);
          return { mutation, identity };
        });
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
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = saveUserAssetCas('worldbook', filename, raw, expected);
          const identity = ensureAssetIdentityInMutation('worldbook', filename);
          return { mutation, identity };
        });
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
      ensureDiscoveredAssetIdentities(listedPresets.map((asset) => ({
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
          const prompts = Array.isArray(body.prompts)
              ? (body.prompts as { role?: string; name?: string; enabled?: boolean; content?: string }[])
              : [];
      if (!file) return json(res, { error: '缺少或无法解析预设引用' }, 400);
      if (prompts.some((x) => typeof x.content !== 'string')) return json(res, { error: 'prompts 缺少 content' }, 400);
      const payload = JSON.stringify({ name: body.name ?? file.replace(/\.json$/, ''), prompts }, null, 2);
      try {
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = saveUserAssetCas('preset', file, payload, expected);
          const identity = ensureAssetIdentityInMutation(
            'preset', file, String(body.name ?? assetDisplayName(file)),
          );
          return { mutation, identity };
        });
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
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = deleteUserAssetCas('preset', file, expected);
          const identity = ensureAssetIdentityInMutation('preset', file);
          return { mutation, identity };
        });
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
      ensureDiscoveredAssetIdentities(listedWorldbooks.map((asset) => ({
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
          const entries = Array.isArray(body.entries) ? (body.entries as Record<string, unknown>[]) : [];
      if (!file) return json(res, { error: '缺少或无法解析世界书引用' }, 400);
      const record: Record<string, unknown> = {};
      for (const e of entries) {
        const uid = String(e.uid ?? `e${Object.keys(record).length + 1}`);
        const { uid: _uid, ...rest } = e;
        record[uid] = { ...rest, uid: Number(uid) || uid };
      }
      const payload = JSON.stringify({ entries: record }, null, 2);
      try {
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = saveUserAssetCas('worldbook', file, payload, expected);
          const identity = ensureAssetIdentityInMutation('worldbook', file);
          return { mutation, identity };
        });
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
        const { mutation, identity } = AGENT_CONTROL_STORE.withAssetMutation(() => {
          const mutation = body.force === true
            ? deleteWorldbookFileCas(file, expected)
            : { ...deleteUserAssetCas('worldbook', file, expected), layer: 'user' as const };
          const identity = ensureAssetIdentityInMutation('worldbook', file);
          return { mutation, identity };
        });
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
    if (method === 'GET' && p === '/api/skills/shadow-metrics') {
      res.setHeader('Cache-Control', 'no-store');
      const selectionMetrics = SESSION_AGENT_SKILL_SHADOW_METRICS.snapshot();
      const runnerMetrics = SESSION_AGENT_SKILL_SHADOW_RUNNER.snapshot();
      const contextShadow = CONTEXT_COMPILER_SHADOW_RUNNER.snapshot();
      const canaryScope = CONTEXT_COMPILER_CANARY?.scope;
      let canaryEnabled = false;
      try { canaryEnabled = Boolean(canaryScope && contextCompilerRuntimeAllows(
        parseContextCompilerRuntimeConfig(process.env), canaryScope.sessionId)); } catch { /* report disabled */ }
      const catalogCache = SESSION_AGENT_SKILL_SHADOW_CATALOG.snapshot();
      const shadowEnabled = SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG.enabled;
      const windowHealth = SESSION_AGENT_SKILL_SHADOW_HEALTH_WINDOW.snapshot(
        selectionMetrics.catalogRevision,
        {
          failed: runnerMetrics.failed,
          dropped: runnerMetrics.dropped,
          catalogRefreshFailures: catalogCache.refreshFailures,
        },
      );
      const promotionStatus = evaluateSessionAgentSkillShadowPromotion(selectionMetrics, {
        enabled: shadowEnabled,
        validationWindowHealthAligned: windowHealth.aligned,
        failed: windowHealth.failed,
        dropped: windowHealth.dropped,
        inFlight: runnerMetrics.inFlight,
        pending: runnerMetrics.pending,
        faulted: runnerMetrics.faulted,
        catalogRefreshFailures: windowHealth.catalogRefreshFailures,
      });
      return json(res, {
        enabled: shadowEnabled,
        runtimeConfig: publicAgentSkillShadowRuntimeSummary(
          SESSION_AGENT_SKILL_SHADOW_RUNTIME_CONFIG,
        ),
        metrics: {
          ...selectionMetrics,
          ...runnerMetrics,
          validationWindowHealthAligned: windowHealth.aligned,
          validationWindowFailed: windowHealth.failed,
          validationWindowDropped: windowHealth.dropped,
          validationWindowCatalogRefreshFailures: windowHealth.catalogRefreshFailures,
          // Selection promotion is based only on turns that actually triggered candidate/legacy
          // evidence. Runner attempts remain a separate operational-health accounting identity.
          ...promotionStatus,
        },
        catalogCache,
        contextCompilerCanary: canaryScope && CONTEXT_COMPILER_CANARY ? {
          configured: true, enabled: canaryEnabled,
          scope: { sessionCount: 1, providerId: canaryScope.providerId, model: canaryScope.model,
            profileDigest: canaryScope.profileDigest },
          ...CONTEXT_COMPILER_CANARY.snapshot(), successMeaning: 'validated-capsule',
        } : { configured: false, enabled: false },
        contextCompilerShadow: { configured: CONTEXT_COMPILER_RUNTIME.mode === 'shadow',
          attempts: contextShadow.attempts, sourceRead: contextShadow.sourceRead, sent: contextShadow.sent,
          completed: contextShadow.completed, failed: contextShadow.failed, dropped: contextShadow.dropped,
          cancelled: contextShadow.cancelled, inFlight: contextShadow.inFlight, pending: contextShadow.pending,
          closed: contextShadow.closed, adopted: contextShadow.adopted, semanticQuality: contextShadow.semanticQuality },
        stylePackage: { enabled: STYLE_PACKAGE_SHADOW_ENABLED, ...STYLE_PACKAGE_SHADOW.snapshot() },
        stylePackageCanary: STYLE_PACKAGE_CANARY.snapshot(),
      });
    }
    if (method === 'GET' && p === '/api/skills') {
      const { listSkills } = await import('../../packages/core/src/skills.ts');
      const { buildAgentSkillCatalog } = await import('./agent-skill-read-model.ts');
      return json(res, buildAgentSkillCatalog(listSkills()));
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
    if (method === 'POST' && p === '/api/skills/candidates/compile') {
        const reply = submitSkillCompile(SKILL_COMPILE_RUNTIME, await readBody(req, 8_192));
        return json(res, reply.body, reply.status);
    }
    const skillCompileJobRoute = matchRouteTemplate('/api/skills/compile-jobs/:jobId', p);
    if (method === 'GET' && skillCompileJobRoute) {
        const reply = readSkillCompile(SKILL_COMPILE_RUNTIME, skillCompileJobRoute.jobId);
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === '/api/skills/candidates/evaluate') {
        const reply = submitSkillEvaluate(SKILL_EVALUATE_RUNTIME, await readBody(req, 4_096));
        return json(res, reply.body, reply.status);
    }
    const skillEvaluateJobRoute = matchRouteTemplate('/api/skills/evaluate-jobs/:jobId', p);
    if (method === 'GET' && skillEvaluateJobRoute) {
        const reply = readSkillEvaluate(SKILL_EVALUATE_RUNTIME, skillEvaluateJobRoute.jobId);
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === '/api/skills/candidates/sample') {
        const reply = submitSkillSample(SKILL_SAMPLE_RUNTIME, await readBody(req, 4_096));
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === '/api/skills/candidates/sample-suite') {
        const reply = submitSkillSampleSuite(SKILL_SAMPLE_RUNTIME, await readBody(req, 4_096));
        return json(res, reply.body, reply.status);
    }
    const skillSampleJobRoute = matchRouteTemplate('/api/skills/sample-jobs/:jobId', p);
    if (method === 'GET' && skillSampleJobRoute) {
        const reply = readSkillSample(SKILL_SAMPLE_RUNTIME, skillSampleJobRoute.jobId);
        return json(res, reply.body, reply.status);
    }
    const skillSampleSuiteRoute = matchRouteTemplate('/api/skills/sample-suites/:suiteId', p);
    if (method === 'GET' && skillSampleSuiteRoute) {
        const reply = readSkillSampleSuite(SKILL_SAMPLE_RUNTIME, skillSampleSuiteRoute.suiteId);
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === '/api/skills/candidates/quality-suite') {
        const reply = submitSkillQualitySuite(SKILL_QUALITY_RUNTIME, await readBody(req, 4_096));
        return json(res, reply.body, reply.status);
    }
    const skillQualitySuiteRoute = matchRouteTemplate('/api/skills/quality-suites/:suiteId', p);
    if (method === 'GET' && skillQualitySuiteRoute) {
        const reply = readSkillQualitySuite(SKILL_QUALITY_RUNTIME, skillQualitySuiteRoute.suiteId);
        return json(res, reply.body, reply.status);
    }
    if (method === 'GET' && p === ADMISSION_DECISIONS_ROUTE) {
        const url = new URL(req.url ?? '/', `http://${HOST}`);
        const sessionId = url.searchParams.get('sessionId');
        const runId = url.searchParams.get('runId');
        const limit = url.searchParams.get('limit');
        const reply = readAdmissionDecisionsApi(AGENT_ADMISSION_LEDGER, {
            ...(sessionId === null ? {} : { sessionId }),
            ...(runId === null ? {} : { runId }),
            ...(limit === null ? {} : { limit }),
        });
        return json(res, reply.body, reply.status);
    }
    if (p === '/api/skills/governance/pin' && (method === 'GET' || method === 'POST')) {
        res.setHeader('Cache-Control', 'no-store');
        const reply = method === 'GET' ? readSkillPinApi(STYLE_PACKAGE_CANARY)
          : await setSkillPinApi(STYLE_PACKAGE_CANARY, await readBody(req, 4_096));
        return json(res, reply.body, reply.status);
    }
    const skillActiveDiffRoute = matchRouteTemplate(SKILL_PROMOTION_ROUTE_TEMPLATES.activeDiff, p);
    if (method === 'GET' && skillActiveDiffRoute) {
        res.setHeader('Cache-Control', 'no-store');
        const reply = await readSkillActiveDiffApi(SKILL_PROMOTION_RUNTIME, skillActiveDiffRoute.candidateId);
        return json(res, reply.body, reply.status);
    }
    if (method === 'GET' && p === SKILL_PROMOTION_ROUTE_TEMPLATES.overview) {
        const url = new URL(req.url ?? '/', `http://${HOST}`);
        const limit = url.searchParams.get('limit');
        const cursor = url.searchParams.get('cursor');
        const reply = readSkillPromotionOverviewApi(SKILL_PROMOTION_RUNTIME, {
            ...(limit === null ? {} : { limit }),
            ...(cursor === null ? {} : { cursor }),
        });
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === SKILL_PROMOTION_ROUTE_TEMPLATES.preflight) {
        const reply = readSkillPromotionPreflightApi(
            SKILL_PROMOTION_RUNTIME, await readBody(req, 8_192));
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === SKILL_PROMOTION_ROUTE_TEMPLATES.adopt) {
        const reply = adoptSkillCandidateApi(SKILL_PROMOTION_RUNTIME, await readBody(req, 8_192));
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === SKILL_PROMOTION_ROUTE_TEMPLATES.promote) {
        const reply = promoteSkillCandidateApi(SKILL_PROMOTION_RUNTIME, await readBody(req, 8_192));
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === SKILL_PROMOTION_ROUTE_TEMPLATES.retire) {
        const reply = retireSkillCandidateApi(SKILL_PROMOTION_RUNTIME, await readBody(req, 8_192));
        return json(res, reply.body, reply.status);
    }
    if (method === 'POST' && p === SKILL_PROMOTION_ROUTE_TEMPLATES.reconcile) {
        // 无入参：body 允许为空，读了就丢，避免沿用上一层的 JSON 形状校验。
        await readBody(req, 1_024);
        const reply = reconcileSkillRetirementsApi(SKILL_PROMOTION_RUNTIME);
        return json(res, reply.body, reply.status);
    }
    const skillChannelRoute = matchRouteTemplate('/api/skills/channels/:channelId', p);
    if (method === 'GET' && skillChannelRoute) {
        const reply = readSkillChannelApi(SKILL_PROMOTION_RUNTIME, skillChannelRoute.channelId);
        return json(res, reply.body, reply.status);
    }
    const skillChannelEvidenceRoute = matchRouteTemplate(SKILL_PROMOTION_ROUTE_TEMPLATES.channelEvidence, p);
    if (method === 'GET' && skillChannelEvidenceRoute) {
        res.setHeader('Cache-Control', 'no-store');
        const reply = readSkillChannelEvidenceApi(SKILL_PROMOTION_RUNTIME, skillChannelEvidenceRoute.channelId);
        return json(res, reply.body, reply.status);
    }
    const skillCandidateDiffRoute = matchRouteTemplate(
        SKILL_PROMOTION_ROUTE_TEMPLATES.candidateDiff, p,
    );
    if (method === 'GET' && skillCandidateDiffRoute) {
        const url = new URL(req.url ?? '/', `http://${HOST}`);
        const against = url.searchParams.get('against');
        const reply = readSkillCandidateDiffApi(
            SKILL_PROMOTION_RUNTIME, skillCandidateDiffRoute.candidateId,
            against === null ? undefined : against,
        );
        return json(res, reply.body, reply.status);
    }
    const skillPromotionEvidenceRoute = matchRouteTemplate(SKILL_PROMOTION_ROUTE_TEMPLATES.evidence, p);
    if (method === 'GET' && skillPromotionEvidenceRoute) {
        res.setHeader('Cache-Control', 'no-store');
        const url = new URL(req.url ?? '/', `http://${HOST}`);
        const reply = listSkillPromotionEvidenceApi(SKILL_PROMOTION_RUNTIME, skillPromotionEvidenceRoute.candidateId,
            url.searchParams.get('batchCursor') ?? '', url.searchParams.get('qualityCursor') ?? '',
            url.searchParams.get('expectedBatchId') ?? '');
        return json(res, reply.body, reply.status);
    }
    const skillOperationalSourcesRoute = matchRouteTemplate('/api/skills/candidates/:candidateId/operational-sources', p);
    if (method === 'GET' && skillOperationalSourcesRoute) {
      const reply = listSkillOperationalSources(SKILL_OPERATIONAL_SOURCE, AGENT_CLOSURE_STORE,
        skillOperationalSourcesRoute.candidateId, AGENT_SKILL_CANDIDATE_RUNTIME);
      return json(res, reply.body, reply.status);
    }
    const skillOperationalSourceRoute = matchRouteTemplate(
      '/api/skills/candidates/:candidateId/operational-sources/:operationId', p,
    );
    if (method === 'GET' && skillOperationalSourceRoute) {
      const reply = readSkillOperationalSource(
        SKILL_OPERATIONAL_SOURCE,
        skillOperationalSourceRoute.candidateId,
        skillOperationalSourceRoute.operationId,
      );
      return json(res, reply.body, reply.status);
    }
    const skillsActionPostRoute = matchRouteTemplate('/api/skills/:name/:action', p);
    if (method === 'POST' && skillsActionPostRoute) {
      const {
        AgentSkillActionError,
        executeAgentSkillAction,
      } = await import('./agent-skill-actions.ts');
      let name: string;
      try {
        name = decodeURIComponent(skillsActionPostRoute.name);
      } catch {
        return json(res, {
          error: 'Agent Skill 名称编码非法',
          code: 'agent-skill-name-invalid',
        }, 400);
      }
      try {
        return json(res, executeAgentSkillAction({
          name,
          action: skillsActionPostRoute.action,
        }));
      } catch (error) {
        if (error instanceof AgentSkillActionError) {
          return json(res, { error: error.message, code: error.code }, error.status);
        }
        throw error;
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
        const providerClient = providerClientForServer(cfg);
        if (!providerClient) (await import('../../packages/proxy/src/config.ts')).assertProviderReady(cfg);
        const mem = new MemoryDb({ path: resolve(DATA_DIR, `storyboard-${Date.now()}.db`) });
        const ret = new RetrievalEngine(mem);
        try {
          ret.setEmbeddingProvider(await createEmbeddingProvider(true));
        } catch {
          ret.setEmbeddingProvider(new HashEmbeddingProvider());
        }
        const orch = new StoryboardOrchestrator({
          client: arbitratedAgentClient(
            observeServerModelClient(providerClient ?? new OpenAICompatibleClient(cfg), () => cfg.providerId),
            { providerId: cfg.providerId, model: cfg.model }, 'story-index'),
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
    // Independent creation namespace; the source RP database is read-only.
    const creativeCollection = matchRouteTemplate('/api/session/:sessionId/creative', p);
    const creativeItem = matchRouteTemplate('/api/session/:sessionId/creative/:creativeId', p);
    const creativeBlindBoard = matchRouteTemplate('/api/session/:sessionId/creative/:creativeId/board/:boardId', p);
    if ((method === 'POST' && creativeCollection) || (method === 'GET' && creativeBlindBoard)
        || (creativeItem && (method === 'GET' || method === 'POST'))) {
      res.setHeader('Cache-Control', 'no-store');
      if (!DIRECTOR_CREATIVE_ENABLED || !DIRECTOR_CREATIVE_SERVICE) return json(res, { error: 'director-disabled' }, 409);
      try {
        const owner = (creativeCollection ?? creativeBlindBoard ?? creativeItem)!.sessionId;
        if (DIRECTOR_NSFW_ENABLED && !sessions.has(owner) && directorPersistedNsfw(owner)) await loadSessionById(owner);
        if (creativeCollection) return json(res, DIRECTOR_CREATIVE_SERVICE.create(creativeCollection.sessionId, await readBody(req)));
        if (creativeBlindBoard) {
          if ([...url.searchParams.keys()].length) return json(res, { error: 'director-request-invalid' }, 400);
          return json(res, DIRECTOR_CREATIVE_SERVICE.readBlindBoard(creativeBlindBoard.sessionId, creativeBlindBoard.creativeId, creativeBlindBoard.boardId));
        }
        const { sessionId, creativeId } = creativeItem!;
        if (method === 'GET') {
          const revision = url.searchParams.get('revision');
          if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length > 1
              || revision !== null && (!/^[1-9][0-9]*$/u.test(revision) || !Number.isSafeInteger(Number(revision))))
            return json(res, { error: 'director-request-invalid' }, 400);
          return json(res, DIRECTOR_CREATIVE_SERVICE.read(sessionId, creativeId, revision === null ? undefined : Number(revision)));
        }
        const result = await DIRECTOR_CREATIVE_SERVICE.command(sessionId, creativeId, await readBody(req), requestAbortController?.signal);
        return json(res, result);
      } catch (error) {
        if (error instanceof ProviderRegistryError) {
          console.warn(`[director-creative] provider=${error.code} diagnostic=${error.diagnosticCode ?? 'unknown'} upstreamStatus=${error.upstreamStatus ?? 'unknown'}`);
          return json(res, { error: 'director-provider-failed' }, providerFailureStatus(error));
        }
        const code = error instanceof Error && /^director-[a-z-]+$/u.test(error.message) ? error.message : 'director-request-failed';
        const status = code === 'director-session-not-found' ? 404 : code.includes('forbidden') || code.includes('permission')
          || code.includes('partition-denied') ? 403 : /conflict|stale|running|cancelled|limit|exhausted|already-attempted/u.test(code) ? 409 : 400;
        return json(res, { error: code }, status);
      }
    }
    // Legacy storyboard engine still writes its original memory_state output.
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
        const providerClient = providerClientForServer(cfg);
        if (!providerClient) assertProviderReady(cfg);
        const gen = new VideoPromptGenerator({
          // P17-01.3：视频提示词是用户在等的前台生成（interactive-prelude），不是后台索引。
          client: arbitratedAgentClient(
            observeServerModelClient(providerClient ?? new OpenAICompatibleClient(cfg), () => cfg.providerId),
            { providerId: cfg.providerId, model: cfg.model }, 'interactive-prelude'),
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
              const body = (await readBody(req)) as Record<string, unknown>;
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
      return json(res, {
        ok: true,
        sessions: sessions.size,
        agentClosure: AGENT_CLOSURE_DEGRADED ? 'degraded' : 'ok',
      });
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
  if (shuttingDown) return;
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
  STYLE_COMPILE_RUNTIME = createServerStyleCompileRuntime();
  const deletionRecovery = await SESSION_DELETION_COORDINATOR.resumePending();
  if (shuttingDown) return;
  if (deletionRecovery.some((result) => result.status === 'accepted')) {
    console.warn('[SessionDeletion] CLEANUP_PENDING（已保留永久 fence，后续重启继续补偿）');
  }
  agentLoopManagerReadersReady = true;
  await turnJobs.recoverAvailable();
  if (shuttingDown) return;
  MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER?.recoverRetained();
  MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER?.recoverRetained();
  ARC_COMMIT_EVIDENCE_SCHEDULER?.recoverRetained();
  WORLDBOOK_APPLY_EVIDENCE_SCHEDULER?.recoverRetained();
  REPORTED_EFFECT_EVIDENCE_SCHEDULER?.recoverRetained();
  NPC_OPERATION_EVIDENCE_SCHEDULER?.recoverRetained();
  // Delivery survives a disabled forward gate and does not need the player to reopen a session.
  for (const file of readdirSync(DATA_DIR)) {
    if (file.endsWith('.db') && resolveSessionDatabase(DATA_DIR, file)) {
      const sessionId = file.slice(0, -3);
      try { recoverEffectWatchForSession(sessionId); }
      catch { console.warn('[AgentClosure] EFFECT_WATCH_RECOVERY_PENDING'); }
      SKILL_CONSUMPTION_SCHEDULER?.schedule(sessionId);
      LEARNING_PREFERENCE_SOURCE_SCHEDULER?.schedule(sessionId);
      EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER?.schedule(sessionId);
      CLOSURE_SKILL_EVIDENCE_SCHEDULER?.schedule(sessionId);
      MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.schedule(sessionId);
      MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.schedule(sessionId);
      REGENERATION_EVIDENCE_SCHEDULER?.schedule(sessionId);
      STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER?.schedule(sessionId);
      VARIABLE_APPLY_EVIDENCE_SCHEDULER?.schedule(sessionId);
      VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER?.schedule(sessionId);
      REPORTED_EFFECT_EVIDENCE_SCHEDULER?.schedule(sessionId);
      BRANCH_MODIFIED_EVIDENCE_SCHEDULER?.schedule(sessionId);
      BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER?.schedule(sessionId);
      PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER?.schedule(sessionId);
      AQL_ADVISORY_EVIDENCE_SCHEDULER?.schedule(sessionId);
      NSFW_SCENE_EVIDENCE_SCHEDULER?.schedule(sessionId);
      MAINTENANCE_MEMORY_CONSUMPTION_SCHEDULER?.schedule(sessionId);
      MAINTENANCE_SUMMARY_CONSUMPTION_SCHEDULER?.schedule(sessionId);
    }
  }
  maintenanceHarness!.recoverExpired();
  // Finish older startup observations first, then repair only the exact
  // pristine p14 namespace in fixed pages. Each page drains below Runtime's
  // queue bound before the next page is read.
  await AGENT_LOOP_RUNTIME.whenIdle();
  if (shuttingDown) return;
  let projectionRecoveryCursor: MaintenanceProductionProjectionRecoveryCursor | null = null;
  for (;;) {
    const recovery = maintenanceJobs.scanAgentLoopProductionProjectionRecovery(
      projectionRecoveryCursor,
    );
    for (const queued of recovery.jobs) {
      AGENT_LOOP_RUNTIME.observeMaintenanceJobPhase({
        runId: queued.runId,
        phase: 'enqueued',
      });
    }
    await AGENT_LOOP_RUNTIME.whenIdle();
    if (shuttingDown) return;
    if (!recovery.nextCursor) break;
    projectionRecoveryCursor = recovery.nextCursor;
  }
  agentLoopLegacySourceReady = true;
  await AGENT_LOOP_RECOVERY_LIFECYCLE.whenIdle();
  await AGENT_LOOP_RECOVERY_LIFECYCLE.runOnce();
  if (shuttingDown) return;
  agentLoopTaskInvalidationDrainer?.start();
  MAINTENANCE_MEMORY_SKILL_SCHEDULER?.schedule();
  MAINTENANCE_MEMORY_WRITE_SCHEDULER?.schedule();
  MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.schedule();
  // Construct the one bounded pump only after every startup projection page
  // is idle. Earlier startup wakes are intentionally coalesced by the single
  // explicit durable-queue request below.
  maintenanceDrainPump = createMaintenanceDrainPump({
    drain: (maxJobs) => maintenanceHarness!.drainAvailable(maxJobs),
    onFailure: () => {
      // Background wake failures never affect foreground turns; queued work is
      // durable and the next enqueue/settled/recovery scan can retry it.
      console.warn('[维护] global drain pump 失败（任务保留待重试）');
    },
  });
  maintenanceHarness!.setMode('shadow');
  // 宿主环境只是能力上限；持久 global kill switch 不因重启被偷偷打开。
  // 该分支会改写用户持久配置（global_enabled），因此无论是否发生变化都要留一行可查的日志：
  // 裸环境调试启动（缺 JG_HARNESS_BACKGROUND=shadow）曾静默关闭用户的维护总开关且无任何痕迹。
  if (!MAINTENANCE_RUNTIME.enabled) {
    const maintenanceGlobalWasEnabled = maintenanceJobs.globalEnabled();
    maintenanceHarness!.setGlobalEnabled(false);
    console.warn(maintenanceGlobalWasEnabled
      ? '[维护] 启动时 JG_HARNESS_BACKGROUND 未设为 shadow：持久总开关 global_enabled 已由 1 改为 0'
        + '（宿主未启用后台维护时不自动打开）。若为调试性启动，请改用 一键启动.bat（加载 profile）重启，再重新开启后台维护。'
      : '[维护] 启动时 JG_HARNESS_BACKGROUND 未设为 shadow：持久总开关保持关闭（global_enabled=0）。');
  }
  if (MAINTENANCE_RUNTIME.enabled && maintenanceJobs.globalEnabled()) {
    maintenanceDrainPump?.request();
  }
  if (shuttingDown) return;
  await OPERATIONAL_REPLAY_BRIDGE?.start();
  if (shuttingDown) return;
  styleCompileStartupReady = true;
  void STYLE_COMPILE_RUNTIME?.runOnce();
  server.listen(PORT, HOST, () => {
    console.log(`[web-api] http://${HOST}:${PORT}`);
    console.log(`[web-api] GET /api/cards | POST /api/session/new(SSE) | POST /api/turn(SSE)`);
  });
}
startPromise = startWebServer().catch(async (error) => {
  agentLoopLegacySourceReady = false;
  styleCompileStartupReady = false;
  AGENT_LOOP_RECOVERY_LIFECYCLE.stop();
  const maintenanceDrainPumpClosed = maintenanceDrainPump?.close();
  // Stop new recovery/pump work and join the recovery tail while Manager and
  // AL Store are still open; only then may Harness close its Manager.
  await quiesceAgentLoopRecovery();
  await maintenanceHarness?.close();
  await maintenanceDrainPumpClosed;
  await STYLE_COMPILE_RUNTIME?.close();
  await CONTEXT_COMPILER_SHADOW_RUNNER.close();
  // Producers own their logical/physical tails. Drain them while their Manager and AL Store remain open.
  await OPERATIONAL_REPLAY_BRIDGE?.close();
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
  agentLoopLegacySourceReady = false;
  styleCompileStartupReady = false;
  STYLE_COMPILE_RUNTIME?.stop();
  AGENT_LOOP_RECOVERY_LIFECYCLE.stop();
  MAINTENANCE_MEMORY_SKILL_SCHEDULER?.close();
  MAINTENANCE_MEMORY_WRITE_SCHEDULER?.close();
  MAINTENANCE_SUMMARY_WRITE_SCHEDULER?.close();
  MAINTENANCE_MEMORY_CONSUMPTION_SCHEDULER?.close();
  MAINTENANCE_SUMMARY_CONSUMPTION_SCHEDULER?.close();
  LEARNING_PREFERENCE_SOURCE_SCHEDULER?.close();
  EXPLICIT_PREFERENCE_EVIDENCE_SCHEDULER?.close();
  CLOSURE_SKILL_EVIDENCE_SCHEDULER?.close();
  MAINTENANCE_MEMORY_EVIDENCE_SCHEDULER?.close();
  MAINTENANCE_SUMMARY_EVIDENCE_SCHEDULER?.close();
  MAINTENANCE_PROPOSAL_REJECTION_EVIDENCE_SCHEDULER?.close();
  MAINTENANCE_PROPOSAL_APPROVAL_EVIDENCE_SCHEDULER?.close();
  ARC_COMMIT_EVIDENCE_SCHEDULER?.close();
  WORLDBOOK_APPLY_EVIDENCE_SCHEDULER?.close();
  NPC_OPERATION_EVIDENCE_SCHEDULER?.close();
  REGENERATION_EVIDENCE_SCHEDULER?.close();
  STYLE_COMPILE_ADOPTION_EVIDENCE_SCHEDULER?.close();
  VARIABLE_APPLY_EVIDENCE_SCHEDULER?.close();
  VARIABLE_INVALIDATION_EVIDENCE_SCHEDULER?.close();
  REPORTED_EFFECT_EVIDENCE_SCHEDULER?.close();
  BRANCH_MODIFIED_EVIDENCE_SCHEDULER?.close();
  BRANCH_ATTRIBUTION_EVIDENCE_SCHEDULER?.close();
  PREFERENCE_INFERENCE_EVIDENCE_SCHEDULER?.close();
  AQL_ADVISORY_EVIDENCE_SCHEDULER?.close();
  NSFW_SCENE_EVIDENCE_SCHEDULER?.close();
  console.log(`[web-api] 收到 ${signal}，正在 drain DSH 插件...`);
  const closePromise = server.listening
    ? new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    : Promise.resolve();
  await pluginMutationTail;
  const maintenanceDrainPumpClosed = maintenanceDrainPump?.close();
  await maintenanceHarness?.close();
  await maintenanceDrainPumpClosed;
  await turnJobs.close();
  await STYLE_COMPILE_RUNTIME?.close();
  await CONTEXT_COMPILER_SHADOW_RUNNER.close();
  await quiesceAgentLoopRecovery();
  await SKILL_QUALITY_RUNTIME?.shutdown();
  await SKILL_SAMPLE_RUNTIME?.shutdown();
  CANDIDATE_EVALUATION_SAMPLE_HOST.close();
  SKILL_EVALUATION_BATCH_STORE?.close();
  SKILL_PROMOTION_RUNTIME?.close();
  STYLE_PACKAGE_PIN_STORE.close();
  await SKILL_EVALUATE_RUNTIME?.shutdown();
  await SKILL_COMPILE_RUNTIME?.shutdown();
  await OPERATIONAL_REPLAY_BRIDGE?.close();
  await DIRECTOR_CREATIVE_SERVICE?.close();
  INTERACTIVE_CALL_LEDGER?.close();
  MODEL_USAGE_LEDGER.close();
  AGENT_ADMISSION_LEDGER?.close();
  AGENT_LEARNING_LEDGER?.close();
  AGENT_EVIDENCE_LEDGER?.close();
  DIRECTOR_CREATIVE_STORE?.close();
  AGENT_SKILL_CANDIDATE_RUNTIME?.close();
  ARC_PROJECTIONS?.close();
  WORLDBOOK_REPAIR_CONTROL?.close();
  AGENT_CONTROL_STORE.close();
  SKILL_CONSUMPTION_SCHEDULER?.close();
  AGENT_CLOSURE_STORE?.close();
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
