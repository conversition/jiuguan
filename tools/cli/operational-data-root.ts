import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

function plainDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

export function resolveOperationalDataDirectory(input: {
  readonly explicit?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}) {
  if (input.explicit) return Object.freeze({ path: resolve(input.explicit), source: 'explicit' as const });
  const env = input.env ?? process.env;
  if (env.JG_USER_DATA_DIR?.trim()) {
    return Object.freeze({ path: resolve(env.JG_USER_DATA_DIR), source: 'environment' as const });
  }
  if (env.LOCALAPPDATA?.trim()) {
    const managedPrivate = resolve(env.LOCALAPPDATA, 'Jiuguan', 'a9-private-data');
    if (plainDirectory(managedPrivate)) {
      return Object.freeze({ path: managedPrivate, source: 'managed-private' as const });
    }
  }
  return Object.freeze({ path: resolve(input.cwd ?? process.cwd(), 'data'), source: 'repository-default' as const });
}
