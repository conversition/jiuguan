/**
 * Backward-compatible CLI entrypoint.
 *
 * Session orchestration lives in packages/session; this file intentionally
 * contains no domain logic so applications never need to depend on tools/cli.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSessionCli } from '../../packages/session/src/session.ts';

export * from '../../packages/session/src/session.ts';

const isMain = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain && await runSessionCli() === 'once') process.exit(0);
