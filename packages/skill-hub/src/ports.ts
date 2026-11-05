import {
  type AgentSkillHeaderV1,
  normalizeAgentSkillHeader,
} from './manifest.ts';
import {
  type AgentSkillAdmissionV1,
  type AgentSkillBodyRequestV1,
} from './materialization.ts';
import {
  type AgentSkillExecutionGrantV1,
  type AgentSkillSelectionReceiptV1,
  type AgentSkillSelectionRequestV1,
} from './selector.ts';
import {
  assertExactKeys,
  assertPlainRecord,
  compareText,
  deepFreeze,
  digestCanonical,
  sha256Digest,
} from './internal.ts';

export const AGENT_SKILL_CATALOG_SNAPSHOT_VERSION = 'agent-skill-catalog-snapshot-v1' as const;

export interface AgentSkillCatalogSnapshotV1 {
  readonly snapshotVersion: typeof AGENT_SKILL_CATALOG_SNAPSHOT_VERSION;
  /** Content-addressed immutable revision of the complete ordered header set. */
  readonly catalogRevision: string;
  readonly headers: readonly AgentSkillHeaderV1[];
}

const SNAPSHOT_KEYS = new Set(['snapshotVersion', 'catalogRevision', 'headers']);

function orderedHeaders(headerInputs: readonly unknown[]): readonly AgentSkillHeaderV1[] {
  if (!Array.isArray(headerInputs) || headerInputs.length > 10_000) {
    throw new TypeError('catalog headers must be an array with at most 10000 items');
  }
  const headers = headerInputs.map(normalizeAgentSkillHeader).sort((left, right) => (
    compareText(left.manifest.skillId, right.manifest.skillId)
    || compareText(left.manifest.version, right.manifest.version)
    || compareText(left.manifestDigest, right.manifestDigest)
  ));
  const refs = new Map<string, string>();
  for (const header of headers) {
    const ref = `${header.manifest.skillId}\u0000${header.manifest.version}`;
    const prior = refs.get(ref);
    if (prior !== undefined) {
      if (prior !== header.manifestDigest) {
        throw new Error(`immutable Skill version collision: ${header.manifest.skillId}@${header.manifest.version}`);
      }
      throw new TypeError(`duplicate catalog header: ${header.manifest.skillId}@${header.manifest.version}`);
    }
    refs.set(ref, header.manifestDigest);
  }
  return Object.freeze(headers);
}

function catalogRevision(headers: readonly AgentSkillHeaderV1[]): string {
  return digestCanonical(headers.map((header) => ({
    skillId: header.manifest.skillId,
    version: header.manifest.version,
    manifestDigest: header.manifestDigest,
  })));
}

export function createAgentSkillCatalogSnapshot(
  headerInputs: readonly unknown[],
): AgentSkillCatalogSnapshotV1 {
  const headers = orderedHeaders(headerInputs);
  return deepFreeze({
    snapshotVersion: AGENT_SKILL_CATALOG_SNAPSHOT_VERSION,
    catalogRevision: catalogRevision(headers),
    headers,
  });
}

export function normalizeAgentSkillCatalogSnapshot(input: unknown): AgentSkillCatalogSnapshotV1 {
  assertPlainRecord(input, 'skillCatalog');
  assertExactKeys(input, SNAPSHOT_KEYS, SNAPSHOT_KEYS, 'skillCatalog');
  if (input.snapshotVersion !== AGENT_SKILL_CATALOG_SNAPSHOT_VERSION) {
    throw new TypeError(`skillCatalog.snapshotVersion must be ${AGENT_SKILL_CATALOG_SNAPSHOT_VERSION}`);
  }
  if (!Array.isArray(input.headers)) throw new TypeError('skillCatalog.headers must be an array');
  const headers = orderedHeaders(input.headers);
  const revision = sha256Digest(input.catalogRevision, 'skillCatalog.catalogRevision');
  if (revision !== catalogRevision(headers)) throw new TypeError('skillCatalog.catalogRevision mismatch');
  return deepFreeze({ snapshotVersion: AGENT_SKILL_CATALOG_SNAPSHOT_VERSION, catalogRevision: revision, headers });
}

/** Storage boundary. Implementations may use files, SQLite or a remote service; the core has no IO. */
export interface AgentSkillCatalogPort {
  readCatalog(): Promise<AgentSkillCatalogSnapshotV1>;
  /**
   * Load only the immutable body named by the request. Implementations must verify the exact
   * catalogRevision plus Skill/version/manifest/body identity and reject revision drift; returning
   * bytes from a newer mutable Catalog would break the service's read/select/load transaction.
   */
  loadBody(request: AgentSkillBodyRequestV1): Promise<string>;
}

/** Service-facing orchestration boundary around deterministic selection and whole-body admission. */
export interface AgentSkillRuntimePort {
  select(request: AgentSkillSelectionRequestV1): Promise<AgentSkillSelectionReceiptV1>;
  materialize(
    receipt: AgentSkillSelectionReceiptV1,
    request: AgentSkillSelectionRequestV1,
    hostGrant: AgentSkillExecutionGrantV1,
  ): Promise<AgentSkillAdmissionV1>;
}

/**
 * Domain adapters translate domain context into the generic selector contract and may validate the
 * resulting admission. They never receive a mutation method for the active catalog.
 */
export interface AgentSkillAdapter<TContext = unknown> {
  readonly adapterId: string;
  readonly capabilityIds: readonly string[];
  buildSelectionRequest(
    context: TContext,
    catalog: AgentSkillCatalogSnapshotV1,
  ): AgentSkillSelectionRequestV1 | Promise<AgentSkillSelectionRequestV1>;
  validateAdmission?(
    admission: AgentSkillAdmissionV1,
    context: TContext,
  ): void | Promise<void>;
}
