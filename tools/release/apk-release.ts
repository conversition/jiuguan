/**
 * P11-04/05/11：APK 静态验收检查 + versionCode 策略 + 权限边界。
 * （P11-04 的 apksigner verify 需 SDK，运行时 fail-closed；此处为可本地验证的静态部分。）
 */

export interface ApkStaticChecksInput {
  buildGradleContent: string;
  manifestContent: string;
  variablesContent: string;
  /** android/app/src/main/assets/capacitor.config.json（同步产物）。 */
  syncedConfigContent: string;
}

export interface ApkStaticFinding {
  readonly rule: string;
  readonly detail: string;
}

export function runApkStaticChecks(input: ApkStaticChecksInput): { findings: ApkStaticFinding[]; passed: boolean } {
  const findings: ApkStaticFinding[] = [];
  const push = (rule: string, cond: boolean, detail: string): void => {
    if (!cond) findings.push({ rule, detail });
  };

  const appId = /applicationId\s+"([^"]+)"/.exec(input.buildGradleContent)?.[1] ?? '';
  push('applicationId 非 .dev 后缀', appId === 'com.jiuguan.app', `实际 ${appId || '未找到'}`);
  push('debug 后缀存在', /applicationIdSuffix\s+".dev"/.test(input.buildGradleContent), 'debug 双身份');
  push('release debuggable=false', /release\s*\{[\s\S]*?debuggable\s+false/.test(input.buildGradleContent), 'P10-02');
  push('minSdk=23', /minSdkVersion\s*=\s*23/.test(input.variablesContent), 'variables.gradle');
  push('targetSdk=34', /targetSdkVersion\s*=\s*34/.test(input.variablesContent), 'variables.gradle');
  push('manifest 无 cleartext', !/usesCleartextTraffic\s*=\s*"true"/.test(input.manifestContent), 'AndroidManifest');
  push('manifest 无 debuggable', !/android:debuggable/.test(input.manifestContent), '由 buildType 控制');
  push('manifest 无宽泛存储权限',
    !/MANAGE_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE/.test(input.manifestContent),
    'P11-11：文件能力走 SAF/系统分享');
  push('backup 受控', !/android:allowBackup\s*=\s*"true"(?![^>]*fullBackupContent)/.test(input.manifestContent)
    || /dataExtractionRules/.test(input.manifestContent), 'P11-04');
  const config = input.syncedConfigContent;
  push('同步产物无 release server.url', !/"url"\s*:/.test(config), 'P11-04');
  push('同步产物禁 cleartext', /"cleartext"\s*:\s*false/.test(config), 'capacitor config');
  push('同步产物 useLegacyBridge=false', /"useLegacyBridge"\s*:\s*false/.test(config), 'P10');
  const permissions = [...input.manifestContent.matchAll(/uses-permission[^>]+android:name=["']([^"']+)["']/g)]
    .map((match) => match[1]);
  const allowedPermissions = new Set([
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
  ]);
  push('权限仅最小网络集合', permissions.every((permission) => allowedPermissions.has(permission)), '最小权限');
  return { findings, passed: findings.length === 0 };
}

// ── P11-05：versionCode 单调策略 ─────────────────────────────────────────

/** versionCode = major*10000 + minor*100 + patch（cap 999.99.99 上限内单调）。 */
export function versionCodeFor(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/.exec(version);
  if (!match) throw new TypeError(`version 非法: ${version}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major > 999 || minor > 99 || patch > 99) throw new TypeError('version 段超出版本编码范围');
  return major * 10_000 + minor * 100 + patch;
}

export interface OverrideInstallCheckInput {
  existing: { applicationId: string; signingSha256: string | null } | null;
  incoming: { applicationId: string; signingSha256: string | null; buildType: 'debug' | 'release' };
}

export type OverrideDecision =
  | { kind: 'fresh-install' }
  | { kind: 'override-ok' }
  | { kind: 'blocked'; reason: string };

/** 覆盖安装前三重校验：同 applicationId + 同签名 + 同 flavor；debug/release 之间必须重新配对。 */
export function checkOverrideInstall(input: OverrideInstallCheckInput): OverrideDecision {
  if (!input.existing) return { kind: 'fresh-install' };
  if (input.existing.applicationId !== input.incoming.applicationId) {
    return { kind: 'blocked', reason: 'applicationId 不同：将产生并行安装而非覆盖，需卸载旧包' };
  }
  const sameFlavor = (input.existing.applicationId.endsWith('.dev')) === (input.incoming.buildType === 'debug');
  if (!sameFlavor) {
    return { kind: 'blocked', reason: 'debug/release 之间切换必须卸载重装并重新配对（P11-10）' };
  }
  if (input.existing.signingSha256 === null || input.incoming.signingSha256 === null) {
    return { kind: 'blocked', reason: '签名指纹未知（未提供 keystore 指纹），拒绝覆盖' };
  }
  if (input.existing.signingSha256 !== input.incoming.signingSha256) {
    return { kind: 'blocked', reason: '签名指纹不一致：卸载重装并重新配对' };
  }
  return { kind: 'override-ok' };
}
