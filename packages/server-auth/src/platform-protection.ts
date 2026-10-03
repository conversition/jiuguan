/**
 * 认证安全目录的 OS 级保护适配器（Windows ACL / POSIX owner+mode / reparse point / 原子写耐久性）。
 *
 * 设计要点：
 * - **判定与探测分离**。`evaluateWindowsAcl()` / `evaluatePosixProtection()` 是纯函数，测试可以
 *   直接喂入任意 ACL 组合与任意身份；`assertPathProtected()` 才去真的调用系统工具。
 * - **allowlist，不是 denylist**（A1R-02）。Windows 下只有"当前用户 SID + SYSTEM +
 *   Administrators"三类主体被允许，其它任何主体——包括未列出的域用户、本地组和未知 SID——
 *   一律 `acl-unsafe`。旧实现用普通主体 denylist + "当前用户名出现过"判定，未列入 denylist 的
 *   主体可以同时持有权限，等于没有"当前用户独占"。
 * - **主体名按完整名比较，绝不按尾段比较**。尾段比较会把 `OTHERDOMAIN\PC` 当成当前用户，
 *   也会混淆任何同名跨域主体。
 * - **DENY 项不是授权**。`icacls` 的 `(DENY)` 条目只会减少权限，不计入"谁有权限"。
 * - **无法验证 = 不安全**。解析不出 ACL / 拿不到当前身份 / 平台不认识，全部抛错而不是放行。
 * - Windows 上 `chmod(0o600)` **不构成**任何证明，必须解析 `icacls`。
 * - **先验后写**（A1R-03）。任何创建动作之前先逐级验证"已存在的祖先"不是 reparse point，
 *   避免父级 junction 把目录或密钥先写到重定向位置再报错。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AuthStorageError } from './storage-error.ts';

export type ProtectedKind = 'file' | 'directory';

export interface AclEntry {
  /** 主体名，可能是 `DOMAIN\name`、裸名或 SID。 */
  readonly principal: string;
  /** `icacls` 的权限括号串，例如 `(OI)(CI)(F)` 或 `(I)(DENY)(W)`。 */
  readonly perms: string;
}

/** 当前用户身份。Windows ACL 判定必须基于 SID，不能只靠用户名。 */
export interface WindowsAclIdentity {
  /** 当前用户 SID（大写，如 `S-1-5-21-…-1001`）。 */
  readonly userSid: string;
  /** 传输/显示用的完整名，如 `DESKTOP-X\pc`；取不到时为 null（只按 SID 比对）。 */
  readonly userName: string | null;
}

/**
 * 允许持有的 OS 主体 SID（除当前用户 SID 外）：
 * `S-1-5-18` = NT AUTHORITY\SYSTEM，`S-1-5-32-544` = BUILTIN\Administrators。
 * 它们本来就能绕过任何用户级保护，把它们算作违规只会让 Windows 上功能完全不可用。
 */
const WINDOWS_ALLOWED_SIDS: ReadonlySet<string> = new Set([
  'S-1-5-18',
  'S-1-5-32-544',
]);

/** 与上面两个 SID 对应的可读名（含裸名，`icacls` 在无法解析域时会直接打印名称或 SID）。 */
const WINDOWS_ALLOWED_NAMES: ReadonlySet<string> = new Set([
  'nt authority\\system',
  'system',
  'builtin\\administrators',
  'administrators',
]);

/** SID 形状：`S-<authority>(-<subauthority>)+`。 */
const WINDOWS_SID_RE = /^S-\d+(?:-\d+)+$/i;

export function isWindowsSid(value: string): boolean {
  return WINDOWS_SID_RE.test(value.trim());
}

/**
 * 规范化完整主体名：小写、`/` 归一为 `\`、折叠内部空白。
 *
 * ⚠️ **不做尾段截断**。旧实现取最后一段，使 `OTHERDOMAIN\PC` 与 `DESKTOP\PC` 无法区分，
 * 这正是 A1R-02 指出的问题。
 */
export function normalizePrincipal(principal: string): string {
  return principal.trim().replace(/\//g, '\\').replace(/\s+/g, ' ').toLowerCase();
}

/** `(DENY)` 条目只减少权限，不是授权。 */
function isDenyAce(perms: string): boolean {
  return perms.toUpperCase().includes('DENY');
}

/**
 * 解析 `icacls` 输出；无法解析出任何条目时返回 null（调用方按不可验证处理）。
 *
 * ⚠️ 主体名**可以含空格**（`NT AUTHORITY\SYSTEM`），因此不能按空白切分取尾段 ——
 * 那样会得到 `AUTHORITY\SYSTEM`，把合法的 OS 主体误判成未授权主体。
 * 正确做法是先把首行的目标路径前缀剥掉（`<target> <principal>:(perms)`），
 * 再取余下部分作为完整主体名。
 *
 * `target` 由调用方传入以精确剥离；缺省时退化为"首行为盘符/UNC 绝对路径"的形状判断。
 */
export function parseIcaclsOutput(stdout: string, target?: string): AclEntry[] | null {
  const entries: AclEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const marker = line.indexOf(':(');
    if (marker < 0) continue;
    const head = stripLeadingTarget(line.slice(0, marker).trim(), target);
    if (!head) continue;
    entries.push({ principal: head, perms: line.slice(marker + 1).trim() });
  }
  return entries.length > 0 ? entries : null;
}

/** 剥掉 `icacls` 首行的目标路径前缀，返回完整主体名。 */
function stripLeadingTarget(head: string, target?: string): string {
  if (head.length === 0) return '';
  if (target && target.length > 0 && head.length > target.length) {
    const prefix = head.slice(0, target.length);
    const same = process.platform === 'win32'
      ? prefix.toLowerCase() === target.toLowerCase()
      : prefix === target;
    if (same) {
      const rest = head.slice(target.length).trim();
      if (rest.length > 0) return rest;
    }
  }
  // 退化路径：行首是盘符或 UNC 绝对路径时，只剥第一个路径 token。
  const match = /^(?:[A-Za-z]:\\|\\\\)\S*\s+/.exec(head);
  if (match && match[0].length < head.length) return head.slice(match[0].length).trim();
  return head;
}

export type ProtectionVerdict =
  | { ok: true }
  | { ok: false; code: 'acl-unsafe' | 'protection-unverified'; detail: string };

/**
 * Windows ACL 判定（默认拒绝）。
 *
 * 规则：
 * 1. 逐条检查**授权**项（跳过 `(DENY)`）：主体必须是当前用户（SID 或完整名）、
 *    `NT AUTHORITY\SYSTEM`、`BUILTIN\Administrators` 之一；其它主体一律 `acl-unsafe`。
 * 2. 再确认当前用户确实持有权限，否则 `protection-unverified`（不是"独占"）。
 * 3. 拿不到当前身份、解析不出 ACL → `protection-unverified`（无法验证即不安全）。
 */
export function evaluateWindowsAcl(
  entries: readonly AclEntry[] | null,
  identity: WindowsAclIdentity | null,
  kind: ProtectedKind,
): ProtectionVerdict {
  if (!entries) {
    return { ok: false, code: 'protection-unverified', detail: `无法解析 ${kind} 的 ACL 输出` };
  }
  if (!identity || !isWindowsSid(identity.userSid)) {
    return { ok: false, code: 'protection-unverified', detail: '无法确定当前用户 SID' };
  }
  const userSid = identity.userSid.trim().toUpperCase();
  const userName = identity.userName ? normalizePrincipal(identity.userName) : null;

  for (const entry of entries) {
    if (isDenyAce(entry.perms)) continue;
    const principal = entry.principal.trim();
    if (isWindowsSid(principal)) {
      const sid = principal.toUpperCase();
      if (sid === userSid || WINDOWS_ALLOWED_SIDS.has(sid)) continue;
      return {
        ok: false,
        code: 'acl-unsafe',
        detail: `${kind} 对未知 SID ${principal} 授予了权限`,
      };
    }
    const name = normalizePrincipal(principal);
    if (userName !== null && name === userName) continue;
    if (WINDOWS_ALLOWED_NAMES.has(name)) continue;
    if (userName === null) {
      // 只有 SID、没有完整名时无法判断这个名字是否就是当前用户 —— 不可验证即不安全。
      return {
        ok: false,
        code: 'protection-unverified',
        detail: `${kind} 的 ACL 含主体名 ${principal}，但当前身份只有 SID 无法比对`,
      };
    }
    return {
      ok: false,
      code: 'acl-unsafe',
      detail: `${kind} 对未授权主体 ${principal} 授予了权限`,
    };
  }

  const hasCurrent = entries.some((entry) => {
    if (isDenyAce(entry.perms)) return false;
    const principal = entry.principal.trim();
    if (isWindowsSid(principal)) return principal.toUpperCase() === userSid;
    return userName !== null && normalizePrincipal(principal) === userName;
  });
  if (!hasCurrent) {
    return {
      ok: false,
      code: 'protection-unverified',
      detail: `${kind} 的 ACL 未包含当前用户 ${identity.userName ?? identity.userSid}`,
    };
  }
  return { ok: true };
}

/** POSIX：owner 必须是当前用户，且不得有任何 group/other 权限位。 */
export function evaluatePosixProtection(
  mode: number,
  uid: number,
  currentUid: number | null,
  kind: ProtectedKind,
): ProtectionVerdict {
  if (currentUid === null) {
    return { ok: false, code: 'protection-unverified', detail: '当前平台无法取得 uid' };
  }
  if (uid !== currentUid) {
    return {
      ok: false,
      code: 'protection-unverified',
      detail: `${kind} 的 owner uid=${uid} 不是当前用户 ${currentUid}`,
    };
  }
  if ((mode & 0o077) !== 0) {
    return {
      ok: false,
      code: 'acl-unsafe',
      detail: `${kind} 存在 group/other 权限位 (mode=${(mode & 0o777).toString(8)})`,
    };
  }
  return { ok: true };
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Windows 系统目录；`whoami` 必须用绝对路径调用。 */
function system32Path(binary: string): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', binary);
}

/**
 * 解析 `whoami /user` 输出。
 *
 * 输出是**本地化**的（中文系统表头是"用户名 / SID"），因此只按
 * `<name> <S-…>` 的形状匹配，不依赖任何表头文字。
 */
export function parseWhoamiUserOutput(stdout: string): WindowsAclIdentity | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(S-\d+(?:-\d+)+)\s*$/.exec(line.trim());
    if (!match) continue;
    return { userSid: match[2].toUpperCase(), userName: match[1] || null };
  }
  return null;
}

/** 解析 PowerShell `WindowsIdentity` 探测输出（SID 一行 + 名称一行）。 */
export function parseWindowsIdentityProbe(stdout: string): WindowsAclIdentity | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const sidLine = lines.find((line) => isWindowsSid(line));
  if (!sidLine) return null;
  const nameLine = lines.find((line) => !isWindowsSid(line) && line.includes('\\'));
  return { userSid: sidLine.toUpperCase(), userName: nameLine ?? null };
}

function runProbe(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * 读取当前进程的 Windows 身份（SID + 完整名）。
 *
 * ⚠️ **必须用 System32 下的绝对路径**调用 `whoami`：本机 PATH 里 PortableGit 的
 * `usr/bin/whoami.exe` 排在前面，裸 `whoami` 会命中那个 POSIX 版工具并直接失败。
 * 两条探测途径都失败时返回 null，调用方按"不可验证"fail-closed。
 */
export function readWindowsIdentity(): WindowsAclIdentity | null {
  const whoami = runProbe(system32Path('whoami.exe'), ['/user']);
  if (whoami) {
    const parsed = parseWhoamiUserOutput(whoami);
    if (parsed) return parsed;
  }
  const probe = runProbe('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$i=[System.Security.Principal.WindowsIdentity]::GetCurrent(); Write-Output $i.User.Value; Write-Output $i.Name',
  ]);
  if (probe) {
    const parsed = parseWindowsIdentityProbe(probe);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 拒绝符号链接与 Windows junction/reparse point。
 *
 * `lstatSync` 在本机 Node 22 + Windows 上**能**把 `mklink /J` 目录 junction 报成符号链接
 * （实测），但仍额外比较 `realpath`：不同平台/版本的识别能力不一致，真实路径与被解析路径
 * 不一致即说明中间有重定向（大小写与分隔符按平台归一）。
 */
export function assertNoReparsePoint(target: string): void {
  let lst;
  try {
    lst = lstatSync(target);
  } catch {
    // 不存在：存在性由调用方按业务语义判断，这里不报错。
    return;
  }
  if (lst.isSymbolicLink()) {
    throw new AuthStorageError('reparse-point', `${target} 是符号链接`);
  }
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new AuthStorageError('protection-unverified', `${target} 无法解析真实路径`);
  }
  const normalize = (value: string): string => {
    const absolute = resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  if (normalize(real) !== normalize(target)) {
    throw new AuthStorageError(
      'reparse-point',
      `${target} 被重定向到 ${real}（junction/reparse point）`,
    );
  }
}

/** 目标的所有祖先目录，从文件系统根到直接父目录（不含 target 自身）。 */
export function ancestorDirectories(target: string): string[] {
  const chain: string[] = [];
  let current = resolve(target);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    chain.push(parent);
    current = parent;
  }
  return chain.reverse();
}

/**
 * **创建前**逐级验证所有**已存在**的祖先目录都不是 reparse point（A1R-03）。
 *
 * 只检查已存在的祖先：调用方随后要创建的目标此时还不存在，这由后续步骤负责。
 */
export function assertAncestorChainNoReparsePoint(target: string): void {
  for (const ancestor of ancestorDirectories(target)) {
    if (!existsSync(ancestor)) continue;
    assertNoReparsePoint(ancestor);
  }
}

/** 真实 `icacls` 调用；失败或无法解析都返回 null，由判定函数 fail-closed。 */
function readWindowsAcl(target: string): AclEntry[] | null {
  try {
    const stdout = execFileSync('icacls', [target], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseIcaclsOutput(stdout, target);
  } catch {
    return null;
  }
}

/** 只验证、不修改：读取路径必须用这个，避免读操作顺手改 ACL。 */
export function assertPathProtected(target: string, kind: ProtectedKind): void {
  assertNoReparsePoint(target);

  let stats;
  try {
    stats = statSync(target);
  } catch {
    throw new AuthStorageError('io-failed', `${target} 不存在或不可读`);
  }
  if (kind === 'directory' && !stats.isDirectory()) {
    throw new AuthStorageError('invalid-layout', `${target} 不是目录`);
  }
  if (kind === 'file' && !stats.isFile()) {
    throw new AuthStorageError('invalid-layout', `${target} 不是普通文件`);
  }

  const verdict = process.platform === 'win32'
    ? evaluateWindowsAcl(readWindowsAcl(target), readWindowsIdentity(), kind)
    : evaluatePosixProtection(
      stats.mode,
      stats.uid,
      currentUid(),
      kind,
    );
  if (!verdict.ok) {
    throw new AuthStorageError(verdict.code, verdict.detail);
  }
}

/** 尽力把 POSIX 权限位收紧到 owner-only；Windows 下依赖 ACL 而非 chmod。 */
export function tightenOwnerOnlyPermissions(target: string): void {
  if (process.platform === 'win32') return;
  try {
    // 目录保留 x 以便进入，其余位全部去掉。
    const mode = statSync(target).isDirectory() ? 0o700 : 0o600;
    chmodSync(target, mode);
  } catch {
    /* 收紧失败时由 assertPathProtected 判定，不在这里吞掉安全性判断 */
  }
}

/**
 * Windows 下用 `icacls` 建立"当前用户独占（+ SYSTEM/Administrators）"的 ACL。
 *
 * ⚠️ 必须**先 `/reset` 再收紧**。实测（Node 22 + Windows）：
 * `icacls <path> /inheritance:r /grant:r "<user>:…"` **不会**移除其它主体的**显式** ACE ——
 * `:/grant:r` 只替换被点名主体的显式项，`/inheritance:r` 只去掉继承项。
 * 因此一个被显式授予过 `Everyone` 的目录，用那一条命令"收紧"之后 Everyone 仍然在列，
 * 等于没有做到"当前用户独占"。`/reset` 会先把 ACL 恢复成全继承状态，随后
 * `/inheritance:r` 去掉继承项、`/grant:r` 只加三条允许项，结果恰好只剩三条。
 * （`/reset` 不能与其它操作写在同一次 `icacls` 调用里，会返回 87 参数错误，故分两次调用。）
 *
 * **只在创建/bootstrap 路径调用**；读取路径只验证，绝不顺手改 ACL。
 */
export function tightenWindowsAcl(
  target: string,
  kind: ProtectedKind,
  identity: WindowsAclIdentity | null = readWindowsIdentity(),
): void {
  if (!identity) {
    throw new AuthStorageError('protection-unverified', '无法确定当前用户身份，拒绝收紧 ACL');
  }
  const who = identity.userName ?? identity.userSid;
  const perms = kind === 'directory' ? '(OI)(CI)F' : 'F';
  const run = (args: string[], step: string): void => {
    try {
      execFileSync('icacls', args, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      throw new AuthStorageError(
        'io-failed',
        `${step}失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  run([target, '/reset', '/q'], '重置 ACL');
  run([
    target,
    '/inheritance:r',
    '/grant:r', `${who}:${perms}`,
    '/grant:r', `NT AUTHORITY\\SYSTEM:${perms}`,
    '/grant:r', `BUILTIN\\Administrators:${perms}`,
  ], '收紧 ACL');
}

/**
 * **建立**保护：先尽力收紧（POSIX chmod；Windows 先验证、必要时 icacls），最后必须验证通过。
 * 任何一步都无法建立可验证保护时抛错，调用方必须 fail-closed（禁止 best-effort 后继续监听）。
 */
export function establishPathProtection(target: string, kind: ProtectedKind): void {
  tightenOwnerOnlyPermissions(target);
  if (process.platform === 'win32') {
    const verdict = evaluateWindowsAcl(readWindowsAcl(target), readWindowsIdentity(), kind);
    if (!verdict.ok) tightenWindowsAcl(target, kind);
  }
  assertPathProtected(target, kind);
}

/** 原子写的耐久性能力。Windows 无法 fsync 目录句柄（实测 EPERM），只能 rename-only。 */
export type DurabilityCapability = 'directory-fsync' | 'rename-only' | 'unknown';

let observedDurability: DurabilityCapability | null = null;

/**
 * 尝试 fsync 目录本身（POSIX），把真实结果记入模块级 capability。
 * 返回是否成功；失败不代表写入失败，只代表"rename 之后没有目录级耐久保证"。
 */
export function fsyncDirectorySync(dir: string): boolean {
  if (process.platform === 'win32') {
    observedDurability = 'rename-only';
    return false;
  }
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    observedDurability = 'directory-fsync';
    return true;
  } catch {
    observedDurability = 'rename-only';
    return false;
  }
}

/**
 * 当前进程已观测到的耐久性能力（A1R-04 的显式降级边界）。
 * 尚未探测时按平台给出预期值：Windows 一定是 rename-only（目录 fsync 被拒）。
 */
export function getDurabilityCapability(): DurabilityCapability {
  if (observedDurability !== null) return observedDurability;
  return process.platform === 'win32' ? 'rename-only' : 'unknown';
}
