import type { CapacitorConfig } from '@capacitor/cli';
import {
  CAPACITOR_APP_HOSTNAME,
  CAPACITOR_APP_SCHEME,
} from '../../packages/mobile-contracts/src/platform.ts';

const buildType = process.env.JG_BUILD_TYPE === 'release' ? 'release' : 'debug';

/**
 * Capacitor reads this file for every sync. The native identity remains the
 * release identity here; Gradle adds `.dev` only to debug builds. This avoids
 * syncing a development application id or WebView debugging flag into a
 * release build by accident.
 */
const config: CapacitorConfig = {
  appId: 'com.jiuguan.app',
  appName: '酒馆提示词Agent',
  webDir: 'www',
  android: {
    allowMixedContent: false,
    useLegacyBridge: false,
    webContentsDebuggingEnabled: buildType === 'debug',
  },
  server: {
    androidScheme: CAPACITOR_APP_SCHEME,
    hostname: CAPACITOR_APP_HOSTNAME,
    cleartext: false,
  },
  plugins: {},
};

export default config;
