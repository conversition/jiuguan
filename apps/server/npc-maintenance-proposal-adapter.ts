import { existsSync } from 'node:fs';
import { CharacterStore, type SourceRef } from '../../packages/memory/src/character.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { StateStore, type PredecessorRef } from '../../packages/memory/src/state-store.ts';
import type { NpcMaintenanceProposalContext } from '../../packages/agent-policy/src/npc-maintenance-proposal.ts';
import type { MaintenancePendingProposalRecord } from './maintenance-job-manager.ts';
import {
  NpcMaintenanceCommitter,
  type NpcMaintenanceCommitResult,
  type NpcMaintenanceRollbackReceipt,
} from './npc-maintenance-committer.ts';
import { resolveSessionDatabase } from './security.ts';

export interface NpcMaintenanceProposalAdapterOptions {
  readonly dataDir: string;
  readonly currentRevision: (sessionId: string) => string;
}

export interface NpcMaintenanceProposalAdapters {
  readonly applyNpcProposal: (pending: MaintenancePendingProposalRecord) => NpcMaintenanceCommitResult;
  readonly rollbackNpcProposal: (anchor: Readonly<Record<string, unknown>>) => NpcMaintenanceRollbackReceipt;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const MESSAGE_REF_RE = /^msg:([1-9][0-9]*)$/u;

function openSessionDb(dataDir: string, sessionId: string): MemoryDb {
  if (!TOKEN_RE.test(sessionId)) throw new Error('npc-maintenance-session-invalid');
  const path = resolveSessionDatabase(dataDir, `${sessionId}.db`);
  if (!path || !existsSync(path)) throw new Error('npc-maintenance-session-not-found');
  return new MemoryDb({ path });
}

function sourceBindings(
  memory: MemoryDb,
  allowedSourceRefs: readonly string[],
): { resolve: (token: string) => SourceRef | null; predecessor: PredecessorRef } {
  const refs = new Map<string, { id: number; round: number }>();
  for (const token of allowedSourceRefs) {
    const matched = MESSAGE_REF_RE.exec(token);
    if (!matched) throw new Error('npc-maintenance-source-ref-invalid');
    const id = Number(matched[1]);
    const row = memory.db.prepare('SELECT id,round FROM chat_log WHERE id=?').get(id) as
      { id: number; round: number } | undefined;
    if (!row || !Number.isSafeInteger(row.round) || row.round < 0) {
      throw new Error('npc-maintenance-source-ref-unresolved');
    }
    refs.set(token, { id: row.id, round: row.round });
  }
  const latest = [...refs.values()].sort((left, right) => (
    right.round - left.round || right.id - left.id
  ))[0];
  if (!latest) throw new Error('npc-maintenance-predecessor-missing');
  return {
    resolve: (token) => {
      const row = refs.get(token);
      return row ? { source: 'message', recordId: String(row.id), recordVersion: 1 } : null;
    },
    predecessor: { round: latest.round, messageId: latest.id, recordVersion: 1 },
  };
}

function instanceIdFor(
  state: StateStore,
  context: NpcMaintenanceProposalContext,
): string {
  const instanceIds = new Set(context.allowedCharacterIds.flatMap((characterId) => {
    const snapshot = state.read({ kind: 'character', key: characterId, sessionKey: context.sessionId });
    return snapshot.instanceId ? [snapshot.instanceId] : [];
  }));
  if (instanceIds.size > 1) throw new Error('npc-maintenance-instance-conflict');
  return [...instanceIds][0] ?? `maintenance:${context.sessionId}`;
}

function committerFor(
  memory: MemoryDb,
  currentRevision: (sessionId: string) => string,
  resolveSourceRef: (sessionId: string, sourceRef: string) => SourceRef | null,
): { committer: NpcMaintenanceCommitter; state: StateStore } {
  const state = new StateStore(memory.db, () => memory.inTransaction);
  const characters = new CharacterStore(memory.db, state);
  return {
    state,
    committer: new NpcMaintenanceCommitter({
      characters,
      currentRevision,
      resolveSourceRef,
      transaction: (work) => memory.transaction(work),
    }),
  };
}

/**
 * Builds the only production bridge allowed to mutate NPC truth from a pending
 * maintenance proposal. It opens the exact session DB, resolves admitted
 * message tokens locally, and never exposes CharacterStore as a generic writer.
 */
export function createNpcMaintenanceProposalAdapters(
  options: NpcMaintenanceProposalAdapterOptions,
): NpcMaintenanceProposalAdapters {
  return Object.freeze({
    applyNpcProposal: (pending: MaintenancePendingProposalRecord) => {
      if (pending.taskKind !== 'npc_state' || pending.proposal.taskKind !== 'npc_state') {
        throw new Error('npc-maintenance-proposal-kind-invalid');
      }
      const context = pending.context as NpcMaintenanceProposalContext;
      const memory = openSessionDb(options.dataDir, pending.sessionId);
      try {
        const recoveryRuntime = committerFor(memory, options.currentRevision, () => null);
        const recovered = recoveryRuntime.committer.recoverApplied({
          runId: pending.jobRunId,
          proposal: pending.proposal.payload,
          context,
          provenanceDigest: pending.proposalDigest,
        });
        if (recovered) return recovered;
        const bindings = sourceBindings(memory, context.allowedSourceRefs);
        const runtime = committerFor(memory, options.currentRevision, (_sessionId, token) => bindings.resolve(token));
        return runtime.committer.commit({
          runId: pending.jobRunId,
          proposal: pending.proposal.payload,
          context,
          provenanceDigest: pending.proposalDigest,
          instanceId: instanceIdFor(runtime.state, context),
          historyEpoch: runtime.state.historyEpoch(pending.sessionId),
          predecessor: bindings.predecessor,
        });
      } finally {
        memory.close();
      }
    },
    rollbackNpcProposal: (anchor: Readonly<Record<string, unknown>>) => {
      const sessionId = typeof anchor.sessionId === 'string' ? anchor.sessionId : '';
      const memory = openSessionDb(options.dataDir, sessionId);
      try {
        const runtime = committerFor(memory, options.currentRevision, () => null);
        return runtime.committer.rollback(anchor);
      } finally {
        memory.close();
      }
    },
  });
}
