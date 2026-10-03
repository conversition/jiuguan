import { API_PROTOCOL_VERSION, type ProtocolRange } from './version.ts';
import {
  isServerAuthDescriptor,
  type ServerAuthDescriptor,
} from './auth.ts';
import { isSafeOpaqueId } from './http.ts';

export interface PublicProviderCapabilities {
  listModels: boolean;
  stream: boolean;
  tools: boolean;
  vision: boolean;
  chatCompletions: boolean;
  responses?: boolean;
  messages?: boolean;
}

/** Provider 的线协议公开投影；严禁加入 key、Cookie、Base URL。 */
export interface PublicProviderDescriptor {
  id: string;
  displayName: string;
  adapterVersion: string;
  protocolVersion: number;
  capabilities: PublicProviderCapabilities;
  configured: boolean;
}

export interface ServerFeatureDescriptor {
  version: number;
  [key: string]: unknown;
}

export interface ServerMeta {
  app: {
    name: 'jiuguan';
    version: string;
    buildSha?: string;
  };
  api: ProtocolRange & {
    protocolVersion: number;
  };
  /** 同一用户数据目录跨进程重启稳定；换电脑或重装后变化。 */
  serverId: string;
  /** 单次服务端进程 epoch；变化意味着事件游标需要重新同步。 */
  serverInstanceId: string;
  now: string;
  features: {
    events?: ServerFeatureDescriptor & { replay: boolean };
    fileTransfer?: ServerFeatureDescriptor & {
      maxImportBytes: number;
      streamingUpload: boolean;
      resumableUpload: boolean;
      uploadPath: '/api/assets/import';
      authenticatedDownload?: boolean;
      downloadGrantPath?: '/api/assets/download-capabilities';
      downloadPathTemplate?: '/api/assets/download/{assetId}/{format}';
    };
    providerRegistry?: ServerFeatureDescriptor;
    maintenanceHarness?: ServerFeatureDescriptor & {
      available: boolean;
      mode: 'shadow';
    };
    interactiveHarness?: ServerFeatureDescriptor & {
      available: boolean;
      mode: 'off' | 'shadow' | 'on';
      writesEnabled: boolean;
    };
    [key: string]: ServerFeatureDescriptor | undefined;
  };
  providers: PublicProviderDescriptor[];
  auth: ServerAuthDescriptor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isProviderDescriptor(value: unknown): value is PublicProviderDescriptor {
  if (!isRecord(value) || !isRecord(value.capabilities)) return false;
  const c = value.capabilities;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.displayName)
    && isNonEmptyString(value.adapterVersion)
    && Number.isInteger(value.protocolVersion)
    && typeof value.configured === 'boolean'
    && typeof c.listModels === 'boolean'
    && typeof c.stream === 'boolean'
    && typeof c.tools === 'boolean'
    && typeof c.vision === 'boolean'
    && typeof c.chatCompletions === 'boolean'
    && (c.responses === undefined || typeof c.responses === 'boolean')
    && (c.messages === undefined || typeof c.messages === 'boolean');
}

function isFeatureDescriptor(value: unknown): value is ServerFeatureDescriptor {
  return isRecord(value) && Number.isInteger(value.version);
}

export function isServerMeta(value: unknown): value is ServerMeta {
  if (!isRecord(value)
    || !isRecord(value.app)
    || !isRecord(value.api)
    || !isRecord(value.features)
    || !isRecord(value.auth)
    || !Array.isArray(value.providers)) {
    return false;
  }
  const featuresValid = Object.values(value.features)
    .every((feature) => feature === undefined || isFeatureDescriptor(feature));
  const events = value.features.events;
  const fileTransfer = value.features.fileTransfer;
  const maintenanceHarness = value.features.maintenanceHarness;
  const interactiveHarness = value.features.interactiveHarness;
  return value.app.name === 'jiuguan'
    && isNonEmptyString(value.app.version)
    && (value.app.buildSha === undefined || isNonEmptyString(value.app.buildSha))
    && Number.isInteger(value.api.protocolVersion)
    && Number.isInteger(value.api.minClientProtocol)
    && Number.isInteger(value.api.maxClientProtocol)
    && Number(value.api.minClientProtocol) <= Number(value.api.maxClientProtocol)
    && isSafeOpaqueId(value.serverId)
    && isNonEmptyString(value.serverInstanceId)
    && isNonEmptyString(value.now)
    && featuresValid
    && (events === undefined
      || (isFeatureDescriptor(events) && typeof events.replay === 'boolean'))
    && (fileTransfer === undefined
      || (isFeatureDescriptor(fileTransfer)
        && Number.isInteger(fileTransfer.maxImportBytes)
        && Number(fileTransfer.maxImportBytes) >= 0
        && typeof fileTransfer.streamingUpload === 'boolean'
        && typeof fileTransfer.resumableUpload === 'boolean'
        && fileTransfer.uploadPath === '/api/assets/import'
        && (fileTransfer.authenticatedDownload === undefined
          || typeof fileTransfer.authenticatedDownload === 'boolean')
        && (fileTransfer.downloadGrantPath === undefined
          || fileTransfer.downloadGrantPath === '/api/assets/download-capabilities')
        && (fileTransfer.downloadPathTemplate === undefined
          || fileTransfer.downloadPathTemplate === '/api/assets/download/{assetId}/{format}')))
    && (maintenanceHarness === undefined
      || (isFeatureDescriptor(maintenanceHarness)
        && typeof maintenanceHarness.available === 'boolean'
        && maintenanceHarness.mode === 'shadow'))
    && (interactiveHarness === undefined
      || (isFeatureDescriptor(interactiveHarness)
        && typeof interactiveHarness.available === 'boolean'
        && (interactiveHarness.mode === 'off'
          || interactiveHarness.mode === 'shadow'
          || interactiveHarness.mode === 'on')
        && typeof interactiveHarness.writesEnabled === 'boolean'
        && (!interactiveHarness.writesEnabled || interactiveHarness.mode === 'on')))
    && isServerAuthDescriptor(value.auth)
    && value.providers.every(isProviderDescriptor);
}

/** P1 默认值仅用于 mock/契约测试；生产 serverInstanceId 必须在服务端生成。 */
export const DEFAULT_API_PROTOCOL = API_PROTOCOL_VERSION;
