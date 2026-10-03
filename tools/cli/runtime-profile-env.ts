import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readRuntimeProfileEnvironment(path: string): Readonly<Record<string, string>> {
  const target = resolve(path);
  if (!existsSync(target)) throw new Error('profile-file-missing');
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('profile-file-invalid');
  const env: Record<string, string> = {};
  for (const sourceLine of readFileSync(target, 'utf8').split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('profile-line-invalid');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) || Object.hasOwn(env, key)) {
      throw new Error('profile-key-invalid');
    }
    env[key] = value;
  }
  return Object.freeze(env);
}
