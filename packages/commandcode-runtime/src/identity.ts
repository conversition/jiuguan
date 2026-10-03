/*
 * Device fingerprint shape and identity policy adapted from commandcode-proxy 1.0.0.
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 */

import { Buffer } from 'node:buffer';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import {
  assertCommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSnapshot,
} from './config.ts';

const API_KEY_PATTERN = /^user_[A-Za-z0-9_-]{1,507}$/;
const FINGERPRINT_ROOT_SALT = 'command-code:device-fingerprint:v1';
const FINGERPRINT_CPUS = Object.freeze([
  Object.freeze({ model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 }),
  Object.freeze({ model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 }),
  Object.freeze({ model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 }),
  Object.freeze({ model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 }),
  Object.freeze({ model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 }),
  Object.freeze({ model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 }),
  Object.freeze({ model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 }),
  Object.freeze({ model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 }),
  Object.freeze({ model: 'Intel(R) Core(TM) i9-14900K', cores: 24 }),
  Object.freeze({ model: 'Intel(R) Core(TM) i7-14700K', cores: 20 }),
  Object.freeze({ model: 'AMD Ryzen 7 7800X3D', cores: 8 }),
  Object.freeze({ model: 'AMD Ryzen 9 7950X', cores: 16 }),
  Object.freeze({ model: 'AMD Ryzen 5 7600', cores: 6 }),
  Object.freeze({ model: 'AMD Ryzen 9 7900X', cores: 12 }),
  Object.freeze({ model: 'AMD Ryzen 7 5800X3D', cores: 8 }),
]);
const FINGERPRINT_MEMORY_GIB = Object.freeze([8, 16, 24, 32, 48, 64]);
const FINGERPRINT_TIMEZONES = Object.freeze([
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Moscow',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Hong_Kong',
  'Australia/Sydney',
  'Pacific/Auckland',
]);
const FINGERPRINT_MAC_COUNTS = Object.freeze([2, 3, 4, 5]);
const FINGERPRINT_OS_USERS = Object.freeze(['dev', 'user', 'admin', 'coder', 'engineer', 'work']);
const FINGERPRINT_MAIL_DOMAINS = Object.freeze(['gmail.com', 'outlook.com', 'qq.com', '163.com']);

export type CommandCodeEntropySource = (length: number) => Uint8Array;

export interface CommandCodeDeviceFingerprintComponents {
  readonly machineIdHash: string;
  readonly macHashes: readonly string[];
  readonly osUserHash: string;
  readonly hostnameHash: string;
  readonly gitEmailHash: string;
  readonly platform: CommandCodeRuntimeConfigSnapshot['deviceProfile']['platform'];
  readonly arch: CommandCodeRuntimeConfigSnapshot['deviceProfile']['arch'];
  readonly osRelease: CommandCodeRuntimeConfigSnapshot['deviceProfile']['osRelease'];
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly memGiB: number;
  readonly isContainer: CommandCodeRuntimeConfigSnapshot['deviceProfile']['isContainer'];
  readonly timezone: string;
  readonly runtime: 'cli';
  readonly collectorVersion: 1;
}

export interface CommandCodeDeviceFingerprint {
  readonly thumbmark: string;
  readonly components: CommandCodeDeviceFingerprintComponents;
}

export class CommandCodeIdentityError extends Error {
  readonly code = 'COMMANDCODE_IDENTITY_FAILED' as const;

  constructor() {
    super('CommandCode identity generation failed');
    this.name = 'CommandCodeIdentityError';
  }
}

export const commandCodeNodeEntropy: CommandCodeEntropySource = (length) => nodeRandomBytes(length);

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function validateApiKey(apiKey: unknown): asserts apiKey is string {
  if (typeof apiKey !== 'string' || !API_KEY_PATTERN.test(apiKey)) {
    throw new CommandCodeIdentityError();
  }
}

function entropyBytes(source: CommandCodeEntropySource, length: number): Buffer {
  try {
    const value = source(length);
    if (
      !(value instanceof Uint8Array)
      || nodeUtilTypes.isProxy(value)
      || value.byteLength !== length
    ) {
      throw new CommandCodeIdentityError();
    }
    return Buffer.from(value);
  } catch {
    throw new CommandCodeIdentityError();
  }
}

function nonZeroHex(bytes: Buffer): string {
  if (bytes.every((value) => value === 0)) throw new CommandCodeIdentityError();
  return bytes.toString('hex');
}

export function createCommandCodeTraceparent(
  entropy: CommandCodeEntropySource = commandCodeNodeEntropy,
): string {
  const traceId = nonZeroHex(entropyBytes(entropy, 16));
  const parentId = nonZeroHex(entropyBytes(entropy, 8));
  return `00-${traceId}-${parentId}-01`;
}

export function createCommandCodeUuid(
  entropy: CommandCodeEntropySource = commandCodeNodeEntropy,
): string {
  const bytes = entropyBytes(entropy, 16);
  if (bytes.every((value) => value === 0)) throw new CommandCodeIdentityError();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCommandCodeLifecycleSessionId(
  entropy: CommandCodeEntropySource = commandCodeNodeEntropy,
): string {
  return `sess_${nonZeroHex(entropyBytes(entropy, 8))}`;
}

export function createCommandCodeJitter(
  maxExclusive: number,
  entropy: CommandCodeEntropySource = commandCodeNodeEntropy,
): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 0) {
    throw new CommandCodeIdentityError();
  }
  if (maxExclusive === 0) return 0;
  const bytes = entropyBytes(entropy, 4);
  const unit = bytes.readUInt32BE(0) / 0x1_0000_0000;
  return Math.floor(unit * maxExclusive);
}

function fingerprintDigest(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  apiKey: string,
  field: string,
): Buffer {
  return sha256(`${snapshot.fingerprintSalt}\0${apiKey}\0${field}`);
}

function pickIndex<T>(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  apiKey: string,
  field: string,
  items: readonly T[],
  labelOf: (item: T) => string,
): number {
  let bestIndex = 0;
  let bestScore: Buffer | undefined;
  for (let index = 0; index < items.length; index++) {
    const score = fingerprintDigest(snapshot, apiKey, `${field}\0${labelOf(items[index]!)}`);
    if (!bestScore || Buffer.compare(score, bestScore) > 0) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function fingerprintHash(value: string): string {
  return sha256(`${FINGERPRINT_ROOT_SALT}\0${value.trim().toLowerCase()}`).toString('hex');
}

export function createCommandCodeRuntimePepper(
  entropy: CommandCodeEntropySource = commandCodeNodeEntropy,
): Uint8Array {
  const pepper = entropyBytes(entropy, 32);
  if (pepper.every((value) => value === 0)) throw new CommandCodeIdentityError();
  return Uint8Array.from(pepper);
}

/** Internal runtime state key. It is intentionally not re-exported by index.ts. */
export function deriveCommandCodeRuntimeCredentialId(
  apiKey: unknown,
  runtimePepper: unknown,
): string {
  validateApiKey(apiKey);
  let pepper: Buffer;
  try {
    if (
      !(runtimePepper instanceof Uint8Array)
      || nodeUtilTypes.isProxy(runtimePepper)
      || runtimePepper.byteLength !== 32
    ) {
      throw new CommandCodeIdentityError();
    }
    pepper = Buffer.from(runtimePepper);
  } catch {
    throw new CommandCodeIdentityError();
  }
  if (pepper.every((value) => value === 0)) throw new CommandCodeIdentityError();
  return createHash('sha256')
    .update('command-code:credential:v2\0')
    .update(pepper)
    .update('\0')
    .update(apiKey)
    .digest('hex');
}

export function deriveCommandCodeIdentitySignature(
  snapshot: CommandCodeRuntimeConfigSnapshot,
): string {
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  return sha256([
    'command-code:identity-config:v2',
    snapshot.protocolVersion,
    snapshot.fingerprintSalt,
    snapshot.deviceProfile.platform,
    snapshot.deviceProfile.arch,
    snapshot.deviceProfile.osRelease,
    String(snapshot.deviceProfile.isContainer),
    snapshot.cliSessionMode,
    String(snapshot.zdr),
    snapshot.upstreamProxy?.url ?? '',
    String(snapshot.proxyConnectTimeoutMs),
    String(snapshot.initializationRequestTimeoutMs),
  ].join('\0')).toString('hex');
}

/** Internal model-cache scope. It is intentionally not re-exported by index.ts. */
export function deriveCommandCodeModelScopeSignature(
  snapshot: CommandCodeRuntimeConfigSnapshot,
): string {
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  return sha256([
    'command-code:model-config:v1',
    snapshot.protocolVersion,
    snapshot.upstreamProxy?.url ?? '',
    String(snapshot.proxyConnectTimeoutMs),
    String(snapshot.modelRequestTimeoutMs),
  ].join('\0')).toString('hex');
}

export function deriveCommandCodeDeviceFingerprint(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  apiKey: unknown,
): Readonly<CommandCodeDeviceFingerprint> {
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  validateApiKey(apiKey);
  const cpu = FINGERPRINT_CPUS[pickIndex(
    snapshot,
    apiKey,
    'cpu',
    FINGERPRINT_CPUS,
    (item) => `${item.model}|${item.cores}`,
  )]!;
  const memGiB = FINGERPRINT_MEMORY_GIB[pickIndex(
    snapshot,
    apiKey,
    'mem',
    FINGERPRINT_MEMORY_GIB,
    String,
  )]!;
  const timezone = FINGERPRINT_TIMEZONES[pickIndex(
    snapshot,
    apiKey,
    'timezone',
    FINGERPRINT_TIMEZONES,
    String,
  )]!;
  const macCount = FINGERPRINT_MAC_COUNTS[pickIndex(
    snapshot,
    apiKey,
    'macCount',
    FINGERPRINT_MAC_COUNTS,
    String,
  )]!;
  const osUser = FINGERPRINT_OS_USERS[pickIndex(
    snapshot,
    apiKey,
    'osUser',
    FINGERPRINT_OS_USERS,
    String,
  )]!;
  const mailDomain = FINGERPRINT_MAIL_DOMAINS[pickIndex(
    snapshot,
    apiKey,
    'mailDomain',
    FINGERPRINT_MAIL_DOMAINS,
    String,
  )]!;
  const hex = (field: string, length: number): string => (
    fingerprintDigest(snapshot, apiKey, field).subarray(0, length).toString('hex')
  );
  const machine = hex('machineId', 16);
  const machineId = `${machine.slice(0, 8)}-${machine.slice(8, 12)}-${machine.slice(12, 16)}-${machine.slice(16, 20)}-${machine.slice(20)}`;
  const macs: string[] = [];
  for (let index = 0; index < macCount; index++) {
    const bytes = fingerprintDigest(snapshot, apiKey, `mac${index}`).subarray(0, 6);
    macs.push([...bytes].map((value) => value.toString(16).padStart(2, '0')).join(':'));
  }
  macs.sort();
  const hostname = `DESKTOP-${hex('hostname', 4).toUpperCase()}`;
  const gitEmail = `${osUser}.${hex('gitEmail', 3)}@${mailDomain}`;
  const thumbSeed = [machineId, macs.join(',')].filter(Boolean);
  const thumbmark = sha256(
    `${FINGERPRINT_ROOT_SALT}\0machine\0${thumbSeed.join('|') || 'unknown'}`,
  ).toString('hex');
  const components = Object.freeze({
    machineIdHash: fingerprintHash(machineId),
    macHashes: Object.freeze(macs.map(fingerprintHash)),
    osUserHash: fingerprintHash(osUser),
    hostnameHash: fingerprintHash(hostname),
    gitEmailHash: fingerprintHash(gitEmail),
    platform: snapshot.deviceProfile.platform,
    arch: snapshot.deviceProfile.arch,
    osRelease: snapshot.deviceProfile.osRelease,
    cpuModel: cpu.model,
    cpuCount: cpu.cores,
    memGiB,
    isContainer: snapshot.deviceProfile.isContainer,
    timezone,
    runtime: 'cli' as const,
    collectorVersion: 1 as const,
  });
  return Object.freeze({ thumbmark, components });
}
