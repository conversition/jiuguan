import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const MAINTENANCE_REPLAY_UNCOMMITTED_MARKER =
  '.maintenance-operational-output-uncommitted' as const;

const SUCCESS_FILE_NAMES = Object.freeze([
  'suite.json',
  'run.json',
  'evaluation.json',
  'bridge-accounting.json',
  'binding.json',
] as const);
const RESERVATION_PAYLOAD_NAMES = new Set<string>([
  ...SUCCESS_FILE_NAMES,
  'failure.json',
]);

export interface MaintenanceReplaySuccessOutput {
  readonly suite: unknown;
  readonly run: unknown;
  readonly evaluation: unknown;
  readonly bridgeAccounting: unknown;
  readonly binding: unknown;
}

export interface MaintenanceReplayOutputDependencies {
  readonly now?: () => Date;
  readonly writeJsonFile?: (path: string, content: string) => void;
  readonly installFile?: (source: string, destination: string) => void;
  readonly commitOutput?: (markerPath: string) => void;
}

export interface MaintenanceReplayOutputPublisher {
  readonly outputDirectory: string;
  publishSuccess(output: MaintenanceReplaySuccessOutput): void;
  publishFailure(failure: unknown): void;
  /** Releases an uncommitted reservation, notably when transport construction fails. */
  release(): void;
}

function jsonContent(value: unknown): string {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) throw new Error('maintenance-operational-output-json-invalid');
  return `${encoded}\n`;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function writeMarker(directory: string): void {
  writeFileSync(join(directory, MAINTENANCE_REPLAY_UNCOMMITTED_MARKER), 'uncommitted\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

/**
 * Reserves the final directory before Provider transport construction and commits by removing
 * one marker. Until that removal, both the staging and final layouts are rejected by the strict
 * Maintenance evidence loader. Payload files are installed with hard-link no-replace semantics.
 */
export function createMaintenanceReplayOutputPublisher(
  input: Readonly<{ dataDirectory: string; explicitOutput?: string }>,
  dependencies: MaintenanceReplayOutputDependencies = {},
): MaintenanceReplayOutputPublisher {
  const now = dependencies.now ?? (() => new Date());
  const stamp = now().toISOString().replace(/[:.]/gu, '-');
  const outputDirectory = resolve(
    input.explicitOutput ?? join(input.dataDirectory, 'p14-evidence', stamp),
  );
  const parentDirectory = dirname(outputDirectory);
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });

  let ownsReservation = false;
  try {
    // mkdir is the cross-platform, atomic no-replace ownership operation. It rejects files,
    // directories, and symlinks alike and closes the old check-then-rename race.
    mkdirSync(outputDirectory, { mode: 0o700 });
    ownsReservation = true;
    writeMarker(outputDirectory);
  } catch (error) {
    if (ownsReservation) rmSync(outputDirectory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('maintenance-operational-output-exists');
    }
    throw error;
  }

  const writeJsonFile = dependencies.writeJsonFile ?? ((path: string, content: string): void => {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  });
  const installFile = dependencies.installFile ?? ((source: string, destination: string): void => {
    // Staging and target share a parent/filesystem. linkSync atomically creates a new directory
    // entry and never replaces a raced destination on either POSIX or Windows.
    linkSync(source, destination);
  });
  const commitOutput = dependencies.commitOutput ?? unlinkSync;
  let state: 'reserved' | 'committed' | 'released' = 'reserved';

  const requireReservation = (): void => {
    if (state !== 'reserved') throw new Error('maintenance-operational-output-not-reserved');
    const markerPath = join(outputDirectory, MAINTENANCE_REPLAY_UNCOMMITTED_MARKER);
    if (!entryExists(markerPath)) throw new Error('maintenance-operational-output-reservation-lost');
  };

  const clearOwnedPayload = (): void => {
    requireReservation();
    for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
      if (entry.name === MAINTENANCE_REPLAY_UNCOMMITTED_MARKER) continue;
      if (!RESERVATION_PAYLOAD_NAMES.has(entry.name)) {
        throw new Error('maintenance-operational-output-reservation-compromised');
      }
      const path = join(outputDirectory, entry.name);
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('maintenance-operational-output-reservation-compromised');
      }
      unlinkSync(path);
    }
  };

  const publish = (files: readonly (readonly [string, unknown])[]): void => {
    requireReservation();
    clearOwnedPayload();
    const encoded = files.map(([name, value]) => [name, jsonContent(value)] as const);
    const stagingDirectory = mkdtempSync(join(
      parentDirectory,
      `.${basename(outputDirectory)}.staging-`,
    ));
    try {
      // The marker is created before any payload, so even a complete staging envelope is never
      // a loadable/importable Maintenance evidence directory.
      writeMarker(stagingDirectory);
      for (const [name, content] of encoded) {
        writeJsonFile(join(stagingDirectory, name), content);
      }
      for (const [name] of encoded) {
        installFile(join(stagingDirectory, name), join(outputDirectory, name));
      }
      // Remove staging before the unique commit point. Once the target marker is removed, the
      // final directory already has its exact terminal layout and no staging cleanup can fail.
      rmSync(stagingDirectory, { recursive: true, force: true });
      commitOutput(join(outputDirectory, MAINTENANCE_REPLAY_UNCOMMITTED_MARKER));
      state = 'committed';
    } catch (error) {
      if (existsSync(stagingDirectory)) {
        rmSync(stagingDirectory, { recursive: true, force: true });
      }
      // Keep the marker until a retry commits. Recognized partial files are removed so a failed
      // success publication can reuse the same reservation for failure-only publication.
      try { clearOwnedPayload(); } catch { /* fail closed: marker remains */ }
      throw error;
    }
  };

  return Object.freeze({
    outputDirectory,
    publishSuccess(output: MaintenanceReplaySuccessOutput): void {
      publish([
        ['suite.json', output.suite],
        ['run.json', output.run],
        ['evaluation.json', output.evaluation],
        ['bridge-accounting.json', output.bridgeAccounting],
        ['binding.json', output.binding],
      ]);
    },
    publishFailure(failure: unknown): void {
      publish([['failure.json', failure]]);
    },
    release(): void {
      if (state !== 'reserved') return;
      clearOwnedPayload();
      const entries = readdirSync(outputDirectory);
      if (entries.length !== 1 || entries[0] !== MAINTENANCE_REPLAY_UNCOMMITTED_MARKER) {
        throw new Error('maintenance-operational-output-reservation-compromised');
      }
      rmSync(outputDirectory, { recursive: true, force: false });
      state = 'released';
    },
  });
}
