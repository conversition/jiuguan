import {
  materializeAgentSkillSelectionAsync,
  normalizeAgentSkillCatalogSnapshot,
  normalizeAgentSkillExecutionGrant,
  normalizeAgentSkillSelectionReceipt,
  normalizeAgentSkillSelectionRequest,
  selectAgentSkillHeaders,
  type AgentSkillAdmissionV1,
  type AgentSkillCatalogPort,
  type AgentSkillExecutionGrantV1,
  type AgentSkillRuntimePort,
  type AgentSkillSelectionReceiptV1,
  type AgentSkillSelectionRequestV1,
} from '@jiuguan/skill-hub';

export const AGENT_SKILL_RUNTIME_REVISION_STALE = 'agent-skill-runtime-catalog-revision-stale' as const;
export const AGENT_SKILL_RUNTIME_RECEIPT_MISMATCH = 'agent-skill-runtime-receipt-mismatch' as const;

export class AgentSkillRuntimeRevisionStaleError extends Error {
  readonly code = AGENT_SKILL_RUNTIME_REVISION_STALE;

  constructor() {
    super(AGENT_SKILL_RUNTIME_REVISION_STALE);
    this.name = 'AgentSkillRuntimeRevisionStaleError';
  }
}

export class AgentSkillRuntimeReceiptMismatchError extends Error {
  readonly code = AGENT_SKILL_RUNTIME_RECEIPT_MISMATCH;

  constructor() {
    super(AGENT_SKILL_RUNTIME_RECEIPT_MISMATCH);
    this.name = 'AgentSkillRuntimeReceiptMismatchError';
  }
}

async function requireCatalogRevision(
  catalogPort: AgentSkillCatalogPort,
  revision: string,
) {
  const catalog = normalizeAgentSkillCatalogSnapshot(await catalogPort.readCatalog());
  if (catalog.catalogRevision !== revision) throw new AgentSkillRuntimeRevisionStaleError();
  return catalog;
}

function translateCatalogLoadError(error: unknown): never {
  if (error instanceof AgentSkillRuntimeRevisionStaleError
    || (error instanceof Error && (
      error.message === 'agent-skill-catalog-revision-stale'
      || error.message === AGENT_SKILL_RUNTIME_REVISION_STALE
    ))) {
    throw new AgentSkillRuntimeRevisionStaleError();
  }
  throw error;
}

async function selectFromAuthoritativeCatalog(
  catalogPort: AgentSkillCatalogPort,
  request: AgentSkillSelectionRequestV1,
): Promise<AgentSkillSelectionReceiptV1> {
  const catalog = await requireCatalogRevision(catalogPort, request.catalogRevision);
  return selectAgentSkillHeaders(catalog.headers, request);
}

async function materializeAuthoritativeSelection(
  catalogPort: AgentSkillCatalogPort,
  receipt: AgentSkillSelectionReceiptV1,
  request: AgentSkillSelectionRequestV1,
  hostGrant: AgentSkillExecutionGrantV1,
  bodyLoadGuard?: Readonly<{
    readonly beforeLoad: () => void | Promise<void>;
    readonly afterLoad: () => void | Promise<void>;
  }>,
): Promise<AgentSkillAdmissionV1> {
  return materializeAgentSkillSelectionAsync(
    receipt,
    hostGrant,
    async (bodyRequest) => {
      await bodyLoadGuard?.beforeLoad();
      try {
        const body = await catalogPort.loadBody(bodyRequest);
        await bodyLoadGuard?.afterLoad();
        return body;
      } catch (error) {
        return translateCatalogLoadError(error);
      }
    },
    request,
  );
}

export interface AgentSkillAdmissionGuard<TAuthorization> {
  /** Authorizes the exact authoritative Receipt before any Skill body can be loaded. */
  authorize(
    receipt: AgentSkillSelectionReceiptV1,
  ): TAuthorization | Promise<TAuthorization>;
  /** Re-reads every authority whose drift would invalidate the authorization. */
  assertCurrent(): void | Promise<void>;
}

export interface GuardedAgentSkillAdmission<TAuthorization> {
  readonly receipt: AgentSkillSelectionReceiptV1;
  readonly admission: AgentSkillAdmissionV1;
  readonly authorization: TAuthorization;
}

export interface ServerAgentSkillRuntimePort extends AgentSkillRuntimePort {
  /**
   * Single authoritative transaction for future live consumers. No caller-provided Receipt crosses
   * this boundary: the current Catalog is selected and materialized before the method returns.
   * Both inputs must be constructed from current host-owned session/control state inside the same
   * trusted service boundary; transport-supplied request or Grant objects are not authority.
   */
  prepareAdmission(
    request: AgentSkillSelectionRequestV1,
    hostGrant: AgentSkillExecutionGrantV1,
  ): Promise<AgentSkillAdmissionV1>;
  /**
   * Guarded preparation for future server-owned Profile admission. Authorization runs against the
   * authoritative Receipt before body IO, while current authority is checked around every load.
   */
  prepareGuardedAdmission<TAuthorization>(
    request: AgentSkillSelectionRequestV1,
    hostGrant: AgentSkillExecutionGrantV1,
    guard: AgentSkillAdmissionGuard<TAuthorization>,
  ): Promise<GuardedAgentSkillAdmission<TAuthorization>>;
}

const SERVER_AGENT_SKILL_RUNTIME_CATALOGS = new WeakMap<object, AgentSkillCatalogPort>();

/**
 * Process-local composition proof. A structural wrapper cannot impersonate the guarded Runtime,
 * and the exact Catalog object prevents a service from pairing authority from two compositions.
 */
export function isServerAgentSkillRuntimeForCatalog(
  candidate: unknown,
  catalogPort: AgentSkillCatalogPort,
): candidate is ServerAgentSkillRuntimePort {
  return typeof candidate === 'object'
    && candidate !== null
    && SERVER_AGENT_SKILL_RUNTIME_CATALOGS.get(candidate) === catalogPort;
}

/**
 * Server-owned composition around the pure SkillHub package. Creating it has no production side effects:
 * callers must explicitly invoke the returned port, so existing Agent behavior remains unchanged.
 */
export function createServerAgentSkillRuntime(catalogPort: AgentSkillCatalogPort): ServerAgentSkillRuntimePort {
  if (!catalogPort || typeof catalogPort.readCatalog !== 'function'
    || typeof catalogPort.loadBody !== 'function') {
    throw new TypeError('Agent Skill catalog port is invalid');
  }
  // Capture both callbacks before any request can await. The port may read live backing state, but
  // replacing its method properties after construction cannot swap the authority implementation.
  const authoritativeCatalogPort: AgentSkillCatalogPort = Object.freeze({
    readCatalog: catalogPort.readCatalog.bind(catalogPort),
    loadBody: catalogPort.loadBody.bind(catalogPort),
  });
  const runtime: ServerAgentSkillRuntimePort = Object.freeze({
    async select(requestInput: AgentSkillSelectionRequestV1): Promise<AgentSkillSelectionReceiptV1> {
      const request = normalizeAgentSkillSelectionRequest(requestInput);
      return selectFromAuthoritativeCatalog(authoritativeCatalogPort, request);
    },
    async prepareAdmission(
      requestInput: AgentSkillSelectionRequestV1,
      hostGrantInput: AgentSkillExecutionGrantV1,
    ): Promise<AgentSkillAdmissionV1> {
      // Freeze both authority inputs before the first await so callers cannot widen them in flight.
      const request = normalizeAgentSkillSelectionRequest(requestInput);
      const hostGrant = normalizeAgentSkillExecutionGrant(hostGrantInput);
      const receipt = await selectFromAuthoritativeCatalog(authoritativeCatalogPort, request);
      return materializeAuthoritativeSelection(
        authoritativeCatalogPort,
        receipt,
        request,
        hostGrant,
      );
    },
    async prepareGuardedAdmission<TAuthorization>(
      requestInput: AgentSkillSelectionRequestV1,
      hostGrantInput: AgentSkillExecutionGrantV1,
      guard: AgentSkillAdmissionGuard<TAuthorization>,
    ): Promise<GuardedAgentSkillAdmission<TAuthorization>> {
      if (!guard || typeof guard.authorize !== 'function'
        || typeof guard.assertCurrent !== 'function') {
        throw new TypeError('Agent Skill admission guard is invalid');
      }
      // Capture validated callbacks before the first await so a mutable wrapper cannot replace
      // authority checks while Catalog selection is in flight.
      const authorize = guard.authorize.bind(guard);
      const assertCurrent = guard.assertCurrent.bind(guard);
      // Freeze both authority inputs before the first await so callers cannot widen them in flight.
      const request = normalizeAgentSkillSelectionRequest(requestInput);
      const hostGrant = normalizeAgentSkillExecutionGrant(hostGrantInput);
      const receipt = await selectFromAuthoritativeCatalog(authoritativeCatalogPort, request);
      const authorization = await authorize(receipt);
      await assertCurrent();
      const admission = await materializeAuthoritativeSelection(
        authoritativeCatalogPort,
        receipt,
        request,
        hostGrant,
        {
          beforeLoad: assertCurrent,
          afterLoad: assertCurrent,
        },
      );
      await assertCurrent();
      return Object.freeze({ receipt, admission, authorization });
    },
    async materialize(
      receiptInput: AgentSkillSelectionReceiptV1,
      requestInput: AgentSkillSelectionRequestV1,
      hostGrant: AgentSkillExecutionGrantV1,
    ) {
      // Compatibility path only. A Receipt is a self-consistent digest, not server authority, so
      // re-run the selector against the complete current Catalog before any body can be loaded.
      const claimedReceipt = normalizeAgentSkillSelectionReceipt(receiptInput);
      const request = normalizeAgentSkillSelectionRequest(requestInput);
      const normalizedHostGrant = normalizeAgentSkillExecutionGrant(hostGrant);
      const authoritativeReceipt = await selectFromAuthoritativeCatalog(
        authoritativeCatalogPort,
        request,
      );
      if (claimedReceipt.receiptDigest !== authoritativeReceipt.receiptDigest) {
        throw new AgentSkillRuntimeReceiptMismatchError();
      }
      return materializeAuthoritativeSelection(
        authoritativeCatalogPort,
        authoritativeReceipt,
        request,
        normalizedHostGrant,
      );
    },
  });
  SERVER_AGENT_SKILL_RUNTIME_CATALOGS.set(runtime, catalogPort);
  return runtime;
}

export interface ServerAgentSkillHubComposition {
  readonly catalogPort: AgentSkillCatalogPort;
  readonly runtimePort: ServerAgentSkillRuntimePort;
}

export function createServerAgentSkillHubComposition(
  catalogPort: AgentSkillCatalogPort,
): ServerAgentSkillHubComposition {
  return Object.freeze({ catalogPort, runtimePort: createServerAgentSkillRuntime(catalogPort) });
}
