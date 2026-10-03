export interface ApkAuditFinding { readonly kind: string; readonly evidence: string }

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['device-token', /\bjg1_[a-f0-9]{24}_[A-Za-z0-9_-]{43}\b/g],
  ['signing-secret-name', /\b(?:storePassword|keyPassword)\s*[=:]/gi],
  // https://localhost 是 Capacitor bundled origin，不是 API 测试端点。
  ['test-endpoint', /(?:http:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2)|https:\/\/(?:10\.0\.2\.2|[^\s"']+\.(?:test|example)|(?:[^\s"'/]+\.)?example\.(?:com|net|org)))(?=[:/\s"']|$)/gi],
  // XML/HTML/SVG namespace identifiers are not network endpoints.
  ['cleartext-endpoint', /http:\/\/(?!(?:schemas\.android\.com|www\.w3\.org)\/)[^\s"'<>]+/gi],
];

/** 输入是 APK 可见字符串 + apkanalyzer manifest 输出；命中即 fail closed。 */
export function scanApkEvidence(text: string): ApkAuditFinding[] {
  const findings: ApkAuditFinding[] = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) findings.push({ kind, evidence: match[0].slice(0, 120) });
  }
  if (/android:debuggable=["']true["']/i.test(text)) {
    findings.push({ kind: 'debuggable', evidence: 'android:debuggable=true' });
  }
  if (/android:usesCleartextTraffic=["']true["']/i.test(text)) {
    findings.push({ kind: 'cleartext-enabled', evidence: 'android:usesCleartextTraffic=true' });
  }
  if (/\bserver\.url\b|live-reload|allowNavigation/i.test(text)) {
    findings.push({ kind: 'remote-webview-config', evidence: 'remote/live reload configuration' });
  }
  return findings;
}
