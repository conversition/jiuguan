/** P11：严格 release manifest 契约。未知字段、路径型文件名和身份错配全部拒绝。 */
import { createHash } from 'node:crypto';

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly buildType: 'debug' | 'release';
  readonly gitCommit: string;
  readonly builtAt: string;
  readonly apiOrigin: string;
  readonly application: {
    readonly applicationId: 'com.jiuguan.app' | 'com.jiuguan.app.dev';
    readonly versionName: string;
    readonly versionCode: number;
    readonly minSdk: number;
    readonly targetSdk: number;
  };
  readonly components: {
    readonly server: string;
    readonly web: string;
    readonly plugin: string;
    readonly mobile: string;
  };
  readonly protocol: {
    readonly api: number;
    readonly minClient: number;
    readonly maxClient: number;
  };
  readonly artifact: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly signing: {
    readonly scheme: 'release-keystore' | 'android-debug';
    readonly certificateSha256: string;
  };
  readonly toolchain: {
    readonly node: string;
    readonly pnpm: string;
    readonly jdk: number;
    readonly gradle: string;
    readonly compileSdk: number;
    readonly capacitor: string;
  };
}

export type ReleaseManifestInput = Omit<ReleaseManifest, 'schemaVersion'>;

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const APK_NAME_RE = /^jiuguan-(?:debug|release)-[0-9A-Za-z.+-]+\.apk$/;

export function sha256FileBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(record).sort().join(',') !== [...expected].sort().join(',')) {
    throw new TypeError(`${label} 字段集不符`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function semver(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) throw new TypeError(`${label} 非法`);
  return value;
}

function positiveInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new TypeError(`${label} 非法`);
  }
  return Number(value);
}

export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  if (input.buildType !== 'debug' && input.buildType !== 'release') throw new TypeError('buildType 非法');
  if (!COMMIT_RE.test(input.gitCommit)) throw new TypeError('gitCommit 必须是 40 位 hex');
  if (!ISO_RE.test(input.builtAt) || new Date(input.builtAt).toISOString() !== input.builtAt) {
    throw new TypeError('builtAt 必须是 canonical ISO 时间');
  }
  const origin = new URL(input.apiOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password || !origin.hostname.toLowerCase().endsWith('.ts.net')) {
    throw new TypeError('apiOrigin 必须是精确 https://*.ts.net origin');
  }
  const expectedId = input.buildType === 'release' ? 'com.jiuguan.app' : 'com.jiuguan.app.dev';
  if (input.application.applicationId !== expectedId) throw new TypeError('applicationId 与 buildType 不一致');
  semver(input.application.versionName, 'versionName');
  positiveInteger(input.application.versionCode, 'versionCode', 2_100_000_000);
  positiveInteger(input.application.minSdk, 'minSdk');
  positiveInteger(input.application.targetSdk, 'targetSdk');
  if (input.application.minSdk > input.application.targetSdk) throw new TypeError('minSdk 不得高于 targetSdk');
  for (const [name, value] of Object.entries(input.components)) semver(value, `components.${name}`);
  positiveInteger(input.protocol.api, 'protocol.api');
  positiveInteger(input.protocol.minClient, 'protocol.minClient');
  positiveInteger(input.protocol.maxClient, 'protocol.maxClient');
  if (input.protocol.minClient > input.protocol.api || input.protocol.api > input.protocol.maxClient) {
    throw new TypeError('protocol 范围不包含 api');
  }
  if (!APK_NAME_RE.test(input.artifact.fileName)) throw new TypeError('artifact.fileName 非法或包含路径');
  positiveInteger(input.artifact.bytes, 'artifact.bytes');
  if (!SHA256_RE.test(input.artifact.sha256)) throw new TypeError('artifact.sha256 非法');
  const expectedScheme = input.buildType === 'release' ? 'release-keystore' : 'android-debug';
  if (input.signing.scheme !== expectedScheme) throw new TypeError('签名 scheme 与 buildType 不一致');
  if (!SHA256_RE.test(input.signing.certificateSha256)) throw new TypeError('签名证书 SHA-256 非法');
  if (typeof input.toolchain.node !== 'string' || typeof input.toolchain.pnpm !== 'string'
    || typeof input.toolchain.gradle !== 'string' || typeof input.toolchain.capacitor !== 'string') {
    throw new TypeError('toolchain 字符串字段非法');
  }
  positiveInteger(input.toolchain.jdk, 'toolchain.jdk');
  positiveInteger(input.toolchain.compileSdk, 'toolchain.compileSdk');
  return Object.freeze({ schemaVersion: 1, ...input, apiOrigin: origin.origin });
}

/** 接受侧深度校验：安装脚本必须先通过，不能依赖 TypeScript 类型断言。 */
export function verifyReleaseManifest(payload: unknown): ReleaseManifest {
  const root = object(payload, 'manifest');
  exactKeys(root, ['schemaVersion', 'buildType', 'gitCommit', 'builtAt', 'apiOrigin', 'application',
    'components', 'protocol', 'artifact', 'signing', 'toolchain'], 'manifest');
  if (root.schemaVersion !== 1) throw new TypeError('schemaVersion 必须=1');
  const application = object(root.application, 'application');
  const components = object(root.components, 'components');
  const protocol = object(root.protocol, 'protocol');
  const artifact = object(root.artifact, 'artifact');
  const signing = object(root.signing, 'signing');
  const toolchain = object(root.toolchain, 'toolchain');
  exactKeys(application, ['applicationId', 'versionName', 'versionCode', 'minSdk', 'targetSdk'], 'application');
  exactKeys(components, ['server', 'web', 'plugin', 'mobile'], 'components');
  exactKeys(protocol, ['api', 'minClient', 'maxClient'], 'protocol');
  exactKeys(artifact, ['fileName', 'bytes', 'sha256'], 'artifact');
  exactKeys(signing, ['scheme', 'certificateSha256'], 'signing');
  exactKeys(toolchain, ['node', 'pnpm', 'jdk', 'gradle', 'compileSdk', 'capacitor'], 'toolchain');
  return buildReleaseManifest({
    buildType: root.buildType as ReleaseManifest['buildType'],
    gitCommit: root.gitCommit as string,
    builtAt: root.builtAt as string,
    apiOrigin: root.apiOrigin as string,
    application: application as unknown as ReleaseManifest['application'],
    components: components as unknown as ReleaseManifest['components'],
    protocol: protocol as unknown as ReleaseManifest['protocol'],
    artifact: artifact as unknown as ReleaseManifest['artifact'],
    signing: signing as unknown as ReleaseManifest['signing'],
    toolchain: toolchain as unknown as ReleaseManifest['toolchain'],
  });
}

export const ADB_DEVICE_MANUAL = 'adb devices 列出的设备状态必须为 device（未授权/离线均拒绝）';
