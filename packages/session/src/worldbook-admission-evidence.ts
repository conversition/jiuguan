import type { ScanResult } from '../../core/src/scanner.ts';
import type { AdmissionFacts } from '../../agent-policy/src/policy-router.ts';
import {
  WORLDBOOK_CONFLICT_LIMITS,
  detectWorldbookConflictEvidence,
} from '../../agent-policy/src/worldbook-conflict-evidence.ts';
import { sha256Digest } from '../../memory/src/learning-outbox.ts';

export interface PolicyWorldbookEvidence {
  readonly availability: AdmissionFacts['worldbookEvidence'];
  readonly conflictCount: number;
  readonly novelty: AdmissionFacts['evidenceNovelty'];
  /** Redacted detector identity; never contains entry/user prose. */
  readonly evidenceDigest: string | null;
}

export interface WorldbookAdmissionEvidenceInput {
  readonly scan: ScanResult | null;
  readonly userInput: string;
  /** Newest-first public chat messages. Hidden prompts and plans must never be supplied here. */
  readonly publicHistory: readonly string[];
  readonly seenEvidenceDigests?: ReadonlySet<string>;
}

const UNKNOWN: PolicyWorldbookEvidence = Object.freeze({
  availability: 'unknown',
  conflictCount: 0,
  novelty: 'novel',
  evidenceDigest: null,
});

const KNOWN_EMPTY: PolicyWorldbookEvidence = Object.freeze({
  availability: 'known',
  conflictCount: 0,
  novelty: 'novel',
  evidenceDigest: null,
});

function canonicalPublicText(value: string): string {
  return value.normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\u00a0 ]+/gu, ' ')
    .trim()
    .replace(/[。！？!?]+$/u, '')
    .trim();
}

/**
 * Project Worldbook evidence for PolicyRouter without disclosing hidden lore.
 *
 * `known` means that the relevant scan completed and every activated entry was
 * already public in user/assistant chat. A hidden, truncated, malformed or
 * otherwise unreadable entry makes the whole projection `unknown`; partial
 * visibility can therefore never manufacture a hard signal.
 */
export function evaluateWorldbookAdmissionEvidence(
  input: WorldbookAdmissionEvidenceInput,
): PolicyWorldbookEvidence {
  try {
    const scan = input.scan;
    if (!scan || !Array.isArray(scan.activated) || !scan.stats || typeof scan.stats !== 'object') {
      return UNKNOWN;
    }
    const budgetDropped = scan.stats.budgetDropped ?? 0;
    if (!Number.isSafeInteger(budgetDropped) || budgetDropped < 0 || budgetDropped > 0
      || scan.activated.length > WORLDBOOK_CONFLICT_LIMITS.entries) {
      return UNKNOWN;
    }
    // A successful empty scan is positive evidence of absence, not a read failure.
    if (scan.activated.length === 0) return KNOWN_EMPTY;

    const publicDigests = new Set<string>();
    let publicChars = 0;
    const admitPublicSegments = (value: string): void => {
      if (publicChars >= WORLDBOOK_CONFLICT_LIMITS.totalChars) return;
      const remaining = WORLDBOOK_CONFLICT_LIMITS.totalChars - publicChars;
      const bounded = String(value ?? '').slice(0, Math.min(8_192, remaining));
      publicChars += bounded.length;
      const whole = canonicalPublicText(bounded);
      if (whole) publicDigests.add(sha256Digest(whole));
      for (const segment of bounded.split(/[\n。！？!?]+/u)) {
        const normalized = canonicalPublicText(segment);
        if ([...normalized].length >= 8) publicDigests.add(sha256Digest(normalized));
      }
    };
    admitPublicSegments(input.userInput);
    for (const row of input.publicHistory) admitPublicSegments(row);

    const source = (text: string, maxChars: number): { publicText: string } | { textDigest: string } => {
      const value = String(text ?? '');
      return value.trim().length > 0 && value.length <= maxChars
        ? { publicText: value }
        : { textDigest: sha256Digest(value) };
    };
    const visibleEntries = scan.activated.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const content = String(entry.content ?? '');
      const normalized = canonicalPublicText(content);
      if ([...normalized].length < 8 || content.length > WORLDBOOK_CONFLICT_LIMITS.entryChars
        || !publicDigests.has(sha256Digest(normalized))) return [];
      return [{
        entryId: `worldbook:${sha256Digest(`${entry.id}\0${entry.uid}`)}`,
        activated: true as const,
        playerVisible: true as const,
        publicText: content,
      }];
    });
    // Never infer from a visible subset while another activated entry remains hidden.
    if (visibleEntries.length !== scan.activated.length) return UNKNOWN;

    const detected = detectWorldbookConflictEvidence({
      entries: visibleEntries,
      userInput: source(input.userInput, WORLDBOOK_CONFLICT_LIMITS.userChars),
      // Admission precedes generation; a digest explicitly represents unavailable final prose.
      finalProse: { textDigest: sha256Digest('policy-public-final-prose:unavailable') },
      publicMemoryDelta: [],
    });
    // Low-confidence/non-comparable evidence remains fail-closed.
    if (detected.verdict === 'unknown') return UNKNOWN;
    const evidenceDigest = detected.hardSignal ? detected.evidenceSetDigest : null;
    return Object.freeze({
      availability: 'known',
      conflictCount: detected.conflictCount,
      novelty: evidenceDigest && input.seenEvidenceDigests?.has(evidenceDigest)
        ? 'duplicate'
        : 'novel',
      evidenceDigest,
    });
  } catch {
    return UNKNOWN;
  }
}
