import {
  ArcMaintenanceCommitter,
  type ArcMaintenanceCommitRequest,
} from './arc-maintenance-committer.ts';
import type { ArcProjectionCommitResult } from './arc-projection-store.ts';
import {
  NpcMaintenanceCommitter,
  type NpcMaintenanceCommitRequest,
  type NpcMaintenanceCommitResult,
} from './npc-maintenance-committer.ts';

export type MaintenanceDomainCommitRequest =
  | ({ readonly domain: 'arc' } & ArcMaintenanceCommitRequest)
  | ({ readonly domain: 'npc' } & NpcMaintenanceCommitRequest);

export type MaintenanceDomainCommitResult = ArcProjectionCommitResult | NpcMaintenanceCommitResult;

/** Explicit router: memory/summary are intentionally not apply-capable in Q8. */
export class MaintenanceDomainCommitter {
  constructor(
    private readonly arc: ArcMaintenanceCommitter,
    private readonly npc: NpcMaintenanceCommitter,
  ) {}

  commit(input: MaintenanceDomainCommitRequest): MaintenanceDomainCommitResult {
    if (input.domain === 'arc') return this.arc.commit(input);
    return this.npc.commit(input);
  }
}
