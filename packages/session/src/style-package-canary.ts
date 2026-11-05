/** Server-injected deterministic style consumer. Never supplied by a transport request. */
import type { StyleChassisObservation, StylePackageSchemaPath } from './skill-selection-observer.ts';
export interface StylePackageCanaryInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly round: number;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly source: Omit<StyleChassisObservation, 'commitDigest'> | null;
}
export interface StylePackageCanaryAdmission {
  readonly instruction: string;
  assertActive(): void;
  assertCurrent(): void;
  rejectOutput(reason: 'output-invalid' | 'budget-exhausted', detail?: 'missing-tool' | 'parse-rejected' | 'normalization-failed' | 'schema-invalid',
    schemaAreas?: readonly ('plan' | 'memory_delta' | 'prose' | 'other')[], schemaPaths?: readonly StylePackageSchemaPath[]): never;
  committed(input: Readonly<{ runId: string; round: number; requestDigest: string;
    assistantMessageId: number; assistantDigest: string }>): void;
  dispose(): void;
}
export interface StylePackageCanaryPort {
  prepare(input: StylePackageCanaryInput): Promise<StylePackageCanaryAdmission | null>;
}
