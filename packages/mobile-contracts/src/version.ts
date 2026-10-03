/** 手机、PWA 与电脑端通信使用的线协议版本。 */
export const API_PROTOCOL_VERSION = 1 as const;
export const MIN_CLIENT_PROTOCOL_VERSION = 1 as const;
export const MAX_CLIENT_PROTOCOL_VERSION = 1 as const;

export interface ProtocolRange {
  minClientProtocol: number;
  maxClientProtocol: number;
}

/** 客户端协议是否落在服务端声明的闭区间内。 */
export function isProtocolCompatible(
  clientProtocol: number,
  range: ProtocolRange,
): boolean {
  return Number.isInteger(clientProtocol)
    && Number.isInteger(range.minClientProtocol)
    && Number.isInteger(range.maxClientProtocol)
    && range.minClientProtocol <= range.maxClientProtocol
    && clientProtocol >= range.minClientProtocol
    && clientProtocol <= range.maxClientProtocol;
}
