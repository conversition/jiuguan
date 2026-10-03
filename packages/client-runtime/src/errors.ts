export type ClientRuntimeErrorCode =
  | 'invalid_endpoint'
  | 'insecure_endpoint'
  | 'capabilities_unavailable'
  | 'invalid_server_meta'
  | 'incompatible_protocol'
  | 'server_identity_mismatch'
  | 'credential_unavailable'
  | 'transport_violation'
  | 'network_error'
  | 'request_deadline_exceeded'
  | 'request_aborted'
  | 'api_error'
  | 'precondition_required'
  | 'revision_conflict'
  | 'invalid_revision_response'
  | 'asset_resource_unavailable'
  | 'asset_resource_too_large'
  | 'asset_media_type_mismatch'
  | 'native_file_adapter_unavailable'
  | 'native_file_operation_failed';

const DEFAULT_MESSAGES: Readonly<Record<ClientRuntimeErrorCode, string>> = Object.freeze({
  invalid_endpoint: '服务器地址无效',
  insecure_endpoint: '远程服务器必须使用 HTTPS',
  capabilities_unavailable: '无法读取服务器能力',
  invalid_server_meta: '服务器能力响应无效',
  incompatible_protocol: '客户端与服务器协议不兼容',
  server_identity_mismatch: '服务器身份与已配对记录不一致',
  credential_unavailable: '当前设备凭据不可用',
  transport_violation: '请求违反认证传输边界',
  network_error: '网络请求失败',
  request_deadline_exceeded: '请求超过截止时间',
  request_aborted: '请求已取消',
  api_error: '服务器拒绝了请求',
  precondition_required: '请先读取资源版本后再提交',
  revision_conflict: '资源已被另一端修改，本地草稿已保留',
  invalid_revision_response: '服务器返回的资源版本无效',
  asset_resource_unavailable: '资产资源不可用',
  asset_resource_too_large: '资产资源超过客户端限制',
  asset_media_type_mismatch: '资产媒体类型不匹配',
  native_file_adapter_unavailable: '当前客户端缺少原生文件适配器',
  native_file_operation_failed: '原生文件操作失败',
});

export class ClientRuntimeError extends Error {
  readonly code: ClientRuntimeErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ClientRuntimeErrorCode,
    options: {
      message?: string;
      retryable?: boolean;
      details?: Readonly<Record<string, string | number | boolean>>;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = 'ClientRuntimeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details === undefined
      ? undefined
      : Object.freeze({ ...options.details });
  }
}

export function isClientRuntimeError(value: unknown): value is ClientRuntimeError {
  return value instanceof ClientRuntimeError;
}
