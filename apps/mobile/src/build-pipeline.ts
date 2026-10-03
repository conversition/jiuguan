/**
 * P10-09：Android 构建管线（P10 计划第 2/5 条的可执行形态）。
 *
 * `planAndroidBuild(env)` 纯函数：从环境变量推断构建计划与缺失前置，
 * fail-closed——缺 SDK/endpoint/version 就明确列出，绝不带着错配置打包装到设备。
 * `scripts/build-android.mjs`（CLI）按计划执行：prepare-www → cap sync → gradlew。
 */

export interface AndroidBuildPlan {
  readonly steps: readonly string[];
  readonly missing: readonly string[];
  readonly feasible: boolean;
}

export interface AndroidBuildEnv {
  androidHome?: string | undefined;
  jgPinnedEndpoint?: string | undefined;
  jgAppVersion?: string | undefined;
  buildType?: 'debug' | 'release' | undefined;
  hasGradlew?: boolean;
  hasKeystoreProperties?: boolean;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export function planAndroidBuild(env: AndroidBuildEnv): AndroidBuildPlan {
  const missing: string[] = [];
  const buildType = env.buildType ?? 'debug';

  if (!env.androidHome) {
    missing.push('ANDROID_HOME 未设置（安装 Android SDK 或指向 %LOCALAPPDATA%\\Android\\Sdk）');
  }
  if (!env.jgPinnedEndpoint) {
    missing.push('JG_PINNED_ENDPOINT 未设置（构建期固定的精确 https origin）');
  } else {
    try {
      const url = new URL(env.jgPinnedEndpoint);
      if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
        throw new Error('not-exact-https-origin');
      }
    } catch {
      missing.push('JG_PINNED_ENDPOINT 必须是无路径/query/凭据的精确 https origin');
    }
  }
  if (!env.jgAppVersion) {
    missing.push('JG_APP_VERSION 未设置（包内版本，UI 唯一真值）');
  } else if (!VERSION_RE.test(env.jgAppVersion)) {
    missing.push('JG_APP_VERSION 必须是合法 semver 包版本');
  }
  if (!env.hasGradlew) {
    missing.push('android/gradlew 缺失（android 平台未生成）');
  }
  if (buildType === 'release' && !env.hasKeystoreProperties) {
    // release 无签名材料：fail-closed（宁可不打包，不打可安装但身份错误的包）
    missing.push('release 构建缺少 android/keystore.properties（签名材料不入库）');
  }

  const steps = [
    'build:web（VITE_JG_CLIENT_PROFILE=android-bundled）',
    'prepare-www（注入 CSP/viewport-fit/version.json）',
    'cap sync android',
    `gradlew assemble${buildType === 'release' ? 'Release' : 'Debug'}`,
    'audit-apk（apkanalyzer + apksigner）',
  ];
  return { steps, missing, feasible: missing.length === 0 };
}
