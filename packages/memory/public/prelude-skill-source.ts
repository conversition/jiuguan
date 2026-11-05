/** Metadata-only Prelude source receipts; this facade grants no execution or replay authority. */
export { PRELUDE_SKILL_SOURCE_RECEIPT_VERSION, createPreludeSkillSourceReceipt,
    parsePreludeSkillSourceReceipt, preludeSkillSourceEvidenceDigest,
    type PreludeSkillSourceReceiptV1 } from '../src/prelude-skill-source.ts';
