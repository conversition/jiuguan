/**
 * Narrow source-level boundary for trusted-local Arc review labels.
 *
 * The central projection remains digest-only.  Source-mode consumers use this
 * public bridge so they do not couple to another workspace package's private
 * `src/**` layout.
 */
export {
  arcProjectionIdForName,
  arcProjectionNames,
} from '../src/arc-projection.ts';
