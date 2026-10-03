const LOCAL_CLIENT_ID_KEY = 'jg-client-id-v1';
let volatileClientId = '';

/**
 * local-only 模式没有服务端设备记录，因此使用浏览器 profile 内的非秘密 clientId。
 * 它只参与本地偏好 namespace，不是认证凭据，也不会发送给服务端。
 */
export function localClientId(): string {
  try {
    const saved = localStorage.getItem(LOCAL_CLIENT_ID_KEY);
    if (saved) return saved;
    const created = 'client.' + crypto.randomUUID();
    localStorage.setItem(LOCAL_CLIENT_ID_KEY, created);
    return created;
  } catch {
    if (!volatileClientId) volatileClientId = 'client.' + crypto.randomUUID();
    return volatileClientId;
  }
}
