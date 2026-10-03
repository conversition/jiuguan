import {
  createHmac,
  hkdfSync,
  randomBytes as systemRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isProxy } from 'node:util/types';

export const AUTH_ROOT_KEY_BYTES = 32;
export const AUTH_DIGEST_BYTES = 32;

const SELECTOR_BYTES = 12;
const SELECTOR_HEX_LENGTH = SELECTOR_BYTES * 2;
const PRESENTED_SECRET_BYTES = 32;
const PRESENTED_SECRET_LENGTH = 43;
const CSRF_TOKEN_LENGTH = 43;
const DEVICE_CREDENTIAL_PREFIX = 'jg1';
const PAIRING_CODE_PREFIX = 'jgp1';
const REDACTED = '[REDACTED]';
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

const SELECTOR_RE = /^[a-f0-9]{24}$/;
const PRESENTED_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const HKDF_SALT = Buffer.from('jiuguan/server-auth/hkdf/v1', 'utf8');
const HMAC_FRAME_LABEL = Buffer.from('jiuguan/server-auth/presented-secret/v1', 'utf8');
const CSRF_FRAME_LABEL = Buffer.from('jiuguan/server-auth/csrf/v1', 'utf8');
const STORAGE_BINDING_LABEL = Buffer.from('jiuguan/server-auth/storage-binding/v1', 'utf8');

const KEY_INFO = {
  'device-credential': Buffer.from('jiuguan/server-auth/key/device-credential/v1', 'utf8'),
  'pairing-code': Buffer.from('jiuguan/server-auth/key/pairing-code/v1', 'utf8'),
  csrf: Buffer.from('jiuguan/server-auth/key/csrf/v1', 'utf8'),
  'asset-capability': Buffer.from('jiuguan/server-auth/key/asset-capability/v1', 'utf8'),
  'storage-binding': Buffer.from('jiuguan/server-auth/key/storage-binding/v1', 'utf8'),
} as const;

type KeyPurpose = keyof typeof KEY_INFO;
export type AuthDigestPurpose =
  | 'device-credential'
  | 'pairing-code'
  | 'asset-capability'
  | 'storage-binding';
type PresentedSecretPurpose = Exclude<AuthDigestPurpose, 'storage-binding'>;
type RandomBytesSource = (size: number) => Uint8Array;

declare const AUTH_SELECTOR_BRAND: unique symbol;
declare const AUTH_DIGEST_BRAND: unique symbol;

export type AuthSelector = string & { readonly [AUTH_SELECTOR_BRAND]: true };
export type AuthDigest<Purpose extends AuthDigestPurpose> = Uint8Array & {
  readonly [AUTH_DIGEST_BRAND]: Purpose;
};

const DUMMY_SELECTOR = '0'.repeat(SELECTOR_HEX_LENGTH) as AuthSelector;
const DUMMY_PRESENTED_SECRET = 'A'.repeat(PRESENTED_SECRET_LENGTH);
const DUMMY_DIGEST = Buffer.alloc(AUTH_DIGEST_BYTES, 0);

export type AuthCryptoErrorCode =
  | 'invalid-root-key'
  | 'invalid-entropy-source'
  | 'entropy-unavailable'
  | 'invalid-selector'
  | 'invalid-secret'
  | 'invalid-csrf-epoch'
  | 'secret-unavailable'
  | 'crypto-destroyed';

const ERROR_MESSAGES: Readonly<Record<AuthCryptoErrorCode, string>> = {
  'invalid-root-key': 'The authentication root key is invalid',
  'invalid-entropy-source': 'The authentication entropy source is invalid',
  'entropy-unavailable': 'Authentication entropy is unavailable',
  'invalid-selector': 'The authentication selector is invalid',
  'invalid-secret': 'The authentication secret is invalid',
  'invalid-csrf-epoch': 'The CSRF epoch is invalid',
  'secret-unavailable': 'The one-time secret is no longer available',
  'crypto-destroyed': 'The authentication crypto context is destroyed',
};

export class AuthCryptoError extends Error {
  readonly code: AuthCryptoErrorCode;

  constructor(code: AuthCryptoErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AuthCryptoError';
    this.code = code;
  }

  toJSON(): { name: string; code: AuthCryptoErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

/**
 * Prevents accidental JSON, string or util.inspect disclosure. The caller must
 * explicitly consume the value once at the exact response/storage boundary.
 */
export interface OneTimeSecret {
  readonly available: boolean;
  take(): string;
  discard(): void;
  toJSON(): string;
  toString(): string;
}

class OneTimeSecretValue implements OneTimeSecret {
  #value: string | null;

  constructor(value: string) {
    this.#value = value;
  }

  get available(): boolean {
    return this.#value !== null;
  }

  take(): string {
    if (this.#value === null) throw new AuthCryptoError('secret-unavailable');
    const value = this.#value;
    this.#value = null;
    return value;
  }

  discard(): void {
    this.#value = null;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [INSPECT_CUSTOM](): string {
    return 'OneTimeSecret([REDACTED])';
  }
}

/**
 * A keyed digest intended for a BLOB column. Its bytes are only released by an
 * explicit storage copy; ordinary serialization and inspection stay redacted.
 */
export interface ProtectedDigest<Purpose extends AuthDigestPurpose = AuthDigestPurpose> {
  readonly purpose: Purpose;
  copyForStorage(): AuthDigest<Purpose>;
  matches(candidate: unknown): boolean;
  destroy(): void;
  toJSON(): string;
  toString(): string;
}

class ProtectedDigestValue<Purpose extends AuthDigestPurpose>
implements ProtectedDigest<Purpose> {
  #bytes: Buffer | null;
  readonly purpose: Purpose;

  constructor(purpose: Purpose, bytes: Uint8Array) {
    if (!isExactBytes(bytes, AUTH_DIGEST_BYTES)) {
      throw new AuthCryptoError('invalid-secret');
    }
    this.purpose = purpose;
    this.#bytes = Buffer.from(bytes);
  }

  copyForStorage(): AuthDigest<Purpose> {
    if (this.#bytes === null) throw new AuthCryptoError('crypto-destroyed');
    return Buffer.from(this.#bytes) as unknown as AuthDigest<Purpose>;
  }

  matches(candidate: unknown): boolean {
    if (this.#bytes === null) throw new AuthCryptoError('crypto-destroyed');
    return constantTimeDigestEqual(this.#bytes, candidate);
  }

  destroy(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [INSPECT_CUSTOM](): string {
    return 'ProtectedDigest([REDACTED])';
  }
}

export interface IssuedVersionedSecret<
  Purpose extends 'device-credential' | 'pairing-code' = 'device-credential' | 'pairing-code',
> {
  readonly kind: Purpose;
  readonly selector: AuthSelector;
  readonly value: OneTimeSecret;
  readonly digest: ProtectedDigest<Purpose>;
}

export type IssuedDeviceCredential = IssuedVersionedSecret<'device-credential'>;
export type IssuedPairingCode = IssuedVersionedSecret<'pairing-code'>;

/**
 * A7 owns the final capability wire format. A1 exposes only selector/secret
 * material and the dedicated digest domain so callers cannot reuse device keys.
 */
export interface AssetCapabilityMaterial {
  readonly selector: AuthSelector;
  readonly secret: OneTimeSecret;
  readonly digest: ProtectedDigest<'asset-capability'>;
}

export interface StorageBindingMaterial {
  readonly generationId: AuthSelector;
  readonly binding: ProtectedDigest<'storage-binding'>;
}

export interface AuthCrypto {
  issueDeviceCredential(): IssuedDeviceCredential;
  deviceCredentialSelector(value: unknown): AuthSelector | null;
  verifyDeviceCredential(value: unknown, expectedDigest?: Uint8Array | null): boolean;

  issuePairingCode(): IssuedPairingCode;
  pairingCodeSelector(value: unknown): AuthSelector | null;
  verifyPairingCode(value: unknown, expectedDigest?: Uint8Array | null): boolean;

  deriveCsrfToken(sessionSelector: AuthSelector, csrfEpoch: number): string;
  verifyCsrfToken(candidate: unknown, sessionSelector: AuthSelector, csrfEpoch: number): boolean;

  issueAssetCapabilityMaterial(): AssetCapabilityMaterial;
  verifyAssetCapabilitySecret(
    selector: unknown,
    secret: unknown,
    expectedDigest?: Uint8Array | null,
  ): boolean;

  issueStorageBindingMaterial(): StorageBindingMaterial;
  deriveStorageBinding(generationId: AuthSelector): ProtectedDigest<'storage-binding'>;
  verifyStorageBinding(generationId: unknown, expectedDigest?: Uint8Array | null): boolean;
  destroy(): void;
}

interface ParsedVersionedSecret {
  selector: AuthSelector;
  secret: string;
}

function isExactBytes(value: unknown, length: number): value is Uint8Array {
  return value instanceof Uint8Array
    && !isProxy(value)
    && value.byteLength === length;
}

function isAllZero(value: Uint8Array): boolean {
  let combined = 0;
  for (const byte of value) combined |= byte;
  return combined === 0;
}

export function isAuthSelector(value: unknown): value is AuthSelector {
  return typeof value === 'string' && SELECTOR_RE.test(value);
}

function isCanonicalPresentedSecret(value: string): boolean {
  if (value.length !== PRESENTED_SECRET_LENGTH || !PRESENTED_SECRET_RE.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.byteLength === PRESENTED_SECRET_BYTES
      && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

function requireSelector(value: unknown): asserts value is AuthSelector {
  if (!isAuthSelector(value)) throw new AuthCryptoError('invalid-selector');
}

function requirePresentedSecret(value: string): void {
  if (!isCanonicalPresentedSecret(value)) throw new AuthCryptoError('invalid-secret');
}

function readEntropy(randomBytes: RandomBytesSource, size: number): Buffer {
  let value: unknown;
  try {
    value = randomBytes(size);
  } catch {
    throw new AuthCryptoError('entropy-unavailable');
  }
  if (!isExactBytes(value, size)) throw new AuthCryptoError('entropy-unavailable');
  // node:crypto.randomBytes returns a fresh Buffer. Taking ownership here lets
  // the caller zero the production entropy instead of leaving an extra copy.
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function randomSelector(randomBytes: RandomBytesSource): AuthSelector {
  const bytes = readEntropy(randomBytes, SELECTOR_BYTES);
  try {
    return bytes.toString('hex') as AuthSelector;
  } finally {
    bytes.fill(0);
  }
}

function randomPresentedSecret(randomBytes: RandomBytesSource): string {
  const bytes = readEntropy(randomBytes, PRESENTED_SECRET_BYTES);
  try {
    return bytes.toString('base64url');
  } finally {
    bytes.fill(0);
  }
}

function parseVersionedSecret(value: unknown, prefix: string): ParsedVersionedSecret | null {
  if (typeof value !== 'string') return null;
  const prefixWithSeparator = `${prefix}_`;
  const separatorIndex = prefixWithSeparator.length + SELECTOR_HEX_LENGTH;
  const expectedLength = separatorIndex + 1 + PRESENTED_SECRET_LENGTH;
  if (value.length !== expectedLength || !value.startsWith(prefixWithSeparator)) return null;
  if (value.charAt(separatorIndex) !== '_') return null;

  const selector = value.slice(prefixWithSeparator.length, separatorIndex);
  const secret = value.slice(separatorIndex + 1);
  if (!isAuthSelector(selector) || !isCanonicalPresentedSecret(secret)) return null;
  return { selector, secret };
}

function encodeFrame(label: Buffer, selector: string, secret: string): Buffer {
  const selectorBytes = Buffer.from(selector, 'ascii');
  const secretBytes = Buffer.from(secret, 'ascii');
  const output = Buffer.allocUnsafe(
    4 + label.byteLength + 4 + selectorBytes.byteLength + 4 + secretBytes.byteLength,
  );
  let offset = 0;
  output.writeUInt32BE(label.byteLength, offset);
  offset += 4;
  label.copy(output, offset);
  offset += label.byteLength;
  output.writeUInt32BE(selectorBytes.byteLength, offset);
  offset += 4;
  selectorBytes.copy(output, offset);
  offset += selectorBytes.byteLength;
  output.writeUInt32BE(secretBytes.byteLength, offset);
  offset += 4;
  secretBytes.copy(output, offset);
  selectorBytes.fill(0);
  secretBytes.fill(0);
  return output;
}

function derivePurposeKey(rootKey: Buffer, purpose: KeyPurpose): Buffer {
  return Buffer.from(
    hkdfSync('sha256', rootKey, HKDF_SALT, KEY_INFO[purpose], AUTH_DIGEST_BYTES),
  );
}

function constantTimeDigestEqual(expected: unknown, candidate: unknown): boolean {
  const expectedValid = isExactBytes(expected, AUTH_DIGEST_BYTES);
  const candidateValid = isExactBytes(candidate, AUTH_DIGEST_BYTES);
  const expectedBytes = expectedValid ? Buffer.from(expected) : Buffer.from(DUMMY_DIGEST);
  const candidateBytes = candidateValid ? Buffer.from(candidate) : Buffer.from(DUMMY_DIGEST);
  try {
    const equal = timingSafeEqual(expectedBytes, candidateBytes);
    return expectedValid && candidateValid && equal;
  } finally {
    expectedBytes.fill(0);
    candidateBytes.fill(0);
  }
}

class NodeAuthCrypto implements AuthCrypto {
  #keys: Record<KeyPurpose, Buffer> | null;
  readonly #randomBytes: RandomBytesSource;

  constructor(rootKey: Uint8Array, randomBytes: RandomBytesSource) {
    if (!isExactBytes(rootKey, AUTH_ROOT_KEY_BYTES) || isAllZero(rootKey)) {
      throw new AuthCryptoError('invalid-root-key');
    }
    if (typeof randomBytes !== 'function' || isProxy(randomBytes)) {
      throw new AuthCryptoError('invalid-entropy-source');
    }

    const rootCopy = Buffer.from(rootKey);
    try {
      this.#keys = {
        'device-credential': derivePurposeKey(rootCopy, 'device-credential'),
        'pairing-code': derivePurposeKey(rootCopy, 'pairing-code'),
        csrf: derivePurposeKey(rootCopy, 'csrf'),
        'asset-capability': derivePurposeKey(rootCopy, 'asset-capability'),
        'storage-binding': derivePurposeKey(rootCopy, 'storage-binding'),
      };
    } finally {
      rootCopy.fill(0);
    }
    this.#randomBytes = randomBytes;
  }

  #key(purpose: KeyPurpose): Buffer {
    if (this.#keys === null) throw new AuthCryptoError('crypto-destroyed');
    return this.#keys[purpose];
  }

  #digest<Purpose extends PresentedSecretPurpose>(
    purpose: Purpose,
    selector: AuthSelector,
    secret: string,
  ): ProtectedDigest<Purpose> {
    requireSelector(selector);
    requirePresentedSecret(secret);
    const frame = encodeFrame(HMAC_FRAME_LABEL, selector, secret);
    let digestBytes: Buffer | null = null;
    try {
      digestBytes = createHmac('sha256', this.#key(purpose)).update(frame).digest();
      return new ProtectedDigestValue(purpose, digestBytes);
    } finally {
      frame.fill(0);
      digestBytes?.fill(0);
    }
  }

  #issueVersioned<Purpose extends IssuedVersionedSecret['kind']>(
    kind: Purpose,
    prefix: string,
  ): IssuedVersionedSecret<Purpose> {
    this.#key(kind);
    const selector = randomSelector(this.#randomBytes);
    const secret = randomPresentedSecret(this.#randomBytes);
    const digest = this.#digest(kind, selector, secret);
    return Object.freeze({
      kind,
      selector,
      value: new OneTimeSecretValue(`${prefix}_${selector}_${secret}`),
      digest,
    });
  }

  #verifyVersioned(
    value: unknown,
    prefix: string,
    purpose: PresentedSecretPurpose,
    expectedDigest?: Uint8Array | null,
  ): boolean {
    const parsed = parseVersionedSecret(value, prefix);
    const selector = parsed?.selector ?? DUMMY_SELECTOR;
    const secret = parsed?.secret ?? DUMMY_PRESENTED_SECRET;
    const computed = this.#digest(purpose, selector, secret);
    try {
      const expected = isExactBytes(expectedDigest, AUTH_DIGEST_BYTES)
        ? expectedDigest
        : DUMMY_DIGEST;
      const matches = computed.matches(expected);
      return parsed !== null
        && isExactBytes(expectedDigest, AUTH_DIGEST_BYTES)
        && matches;
    } finally {
      computed.destroy();
    }
  }

  issueDeviceCredential(): IssuedDeviceCredential {
    return this.#issueVersioned('device-credential', DEVICE_CREDENTIAL_PREFIX);
  }

  deviceCredentialSelector(value: unknown): AuthSelector | null {
    return parseVersionedSecret(value, DEVICE_CREDENTIAL_PREFIX)?.selector ?? null;
  }

  verifyDeviceCredential(value: unknown, expectedDigest?: Uint8Array | null): boolean {
    return this.#verifyVersioned(
      value,
      DEVICE_CREDENTIAL_PREFIX,
      'device-credential',
      expectedDigest,
    );
  }

  issuePairingCode(): IssuedPairingCode {
    return this.#issueVersioned('pairing-code', PAIRING_CODE_PREFIX);
  }

  pairingCodeSelector(value: unknown): AuthSelector | null {
    return parseVersionedSecret(value, PAIRING_CODE_PREFIX)?.selector ?? null;
  }

  verifyPairingCode(value: unknown, expectedDigest?: Uint8Array | null): boolean {
    return this.#verifyVersioned(value, PAIRING_CODE_PREFIX, 'pairing-code', expectedDigest);
  }

  deriveCsrfToken(sessionSelector: AuthSelector, csrfEpoch: number): string {
    requireSelector(sessionSelector);
    if (!Number.isSafeInteger(csrfEpoch) || csrfEpoch < 0) {
      throw new AuthCryptoError('invalid-csrf-epoch');
    }
    const selectorBytes = Buffer.from(sessionSelector, 'ascii');
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64BE(BigInt(csrfEpoch));
    const frame = Buffer.allocUnsafe(
      4 + CSRF_FRAME_LABEL.byteLength + 4 + selectorBytes.byteLength + 8,
    );
    let offset = 0;
    frame.writeUInt32BE(CSRF_FRAME_LABEL.byteLength, offset);
    offset += 4;
    CSRF_FRAME_LABEL.copy(frame, offset);
    offset += CSRF_FRAME_LABEL.byteLength;
    frame.writeUInt32BE(selectorBytes.byteLength, offset);
    offset += 4;
    selectorBytes.copy(frame, offset);
    offset += selectorBytes.byteLength;
    epochBytes.copy(frame, offset);
    selectorBytes.fill(0);
    epochBytes.fill(0);
    try {
      return createHmac('sha256', this.#key('csrf')).update(frame).digest('base64url');
    } finally {
      frame.fill(0);
    }
  }

  verifyCsrfToken(candidate: unknown, sessionSelector: AuthSelector, csrfEpoch: number): boolean {
    const expected = Buffer.from(this.deriveCsrfToken(sessionSelector, csrfEpoch), 'base64url');
    const candidateValid = typeof candidate === 'string'
      && candidate.length === CSRF_TOKEN_LENGTH
      && CSRF_TOKEN_RE.test(candidate)
      && Buffer.from(candidate, 'base64url').toString('base64url') === candidate;
    const candidateBytes = candidateValid
      ? Buffer.from(candidate, 'base64url')
      : Buffer.from(DUMMY_DIGEST);
    try {
      const equal = timingSafeEqual(expected, candidateBytes);
      return candidateValid && equal;
    } finally {
      expected.fill(0);
      candidateBytes.fill(0);
    }
  }

  issueAssetCapabilityMaterial(): AssetCapabilityMaterial {
    this.#key('asset-capability');
    const selector = randomSelector(this.#randomBytes);
    const secret = randomPresentedSecret(this.#randomBytes);
    return Object.freeze({
      selector,
      secret: new OneTimeSecretValue(secret),
      digest: this.#digest('asset-capability', selector, secret),
    });
  }

  verifyAssetCapabilitySecret(
    selector: unknown,
    secret: unknown,
    expectedDigest?: Uint8Array | null,
  ): boolean {
    const selectorValid = isAuthSelector(selector);
    const secretValid = typeof secret === 'string' && isCanonicalPresentedSecret(secret);
    const computed = this.#digest(
      'asset-capability',
      selectorValid ? selector : DUMMY_SELECTOR,
      secretValid ? secret : DUMMY_PRESENTED_SECRET,
    );
    try {
      const expected = isExactBytes(expectedDigest, AUTH_DIGEST_BYTES)
        ? expectedDigest
        : DUMMY_DIGEST;
      const matches = computed.matches(expected);
      return selectorValid
        && secretValid
        && isExactBytes(expectedDigest, AUTH_DIGEST_BYTES)
        && matches;
    } finally {
      computed.destroy();
    }
  }

  issueStorageBindingMaterial(): StorageBindingMaterial {
    this.#key('storage-binding');
    const generationId = randomSelector(this.#randomBytes);
    return Object.freeze({
      generationId,
      binding: this.deriveStorageBinding(generationId),
    });
  }

  deriveStorageBinding(generationId: AuthSelector): ProtectedDigest<'storage-binding'> {
    requireSelector(generationId);
    const frame = encodeFrame(STORAGE_BINDING_LABEL, generationId, DUMMY_PRESENTED_SECRET);
    let digestBytes: Buffer | null = null;
    try {
      digestBytes = createHmac('sha256', this.#key('storage-binding')).update(frame).digest();
      return new ProtectedDigestValue('storage-binding', digestBytes);
    } finally {
      frame.fill(0);
      digestBytes?.fill(0);
    }
  }

  verifyStorageBinding(
    generationId: unknown,
    expectedDigest?: Uint8Array | null,
  ): boolean {
    const generationValid = isAuthSelector(generationId);
    const computed = this.deriveStorageBinding(
      generationValid ? generationId : DUMMY_SELECTOR,
    );
    try {
      const expected = isExactBytes(expectedDigest, AUTH_DIGEST_BYTES)
        ? expectedDigest
        : DUMMY_DIGEST;
      const matches = computed.matches(expected);
      return generationValid
        && isExactBytes(expectedDigest, AUTH_DIGEST_BYTES)
        && matches;
    } finally {
      computed.destroy();
    }
  }

  destroy(): void {
    if (this.#keys === null) return;
    for (const key of Object.values(this.#keys)) key.fill(0);
    this.#keys = null;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT_CUSTOM](): string {
    return 'AuthCrypto([REDACTED])';
  }
}

/** Production factory: entropy always comes from node:crypto.randomBytes. */
export function createAuthCrypto(rootKey: Uint8Array): AuthCrypto {
  return new NodeAuthCrypto(rootKey, systemRandomBytes);
}

/**
 * Source-level test seam. It is deliberately omitted from package root exports
 * so production consumers cannot swap out the CSPRNG through the public API.
 */
export function _createAuthCryptoForTesting(
  rootKey: Uint8Array,
  randomBytes: RandomBytesSource,
): AuthCrypto {
  return new NodeAuthCrypto(rootKey, randomBytes);
}
