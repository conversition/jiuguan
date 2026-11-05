/** Shared query-only readback of original deterministic scene and Skill receipts. */
import type { DatabaseSync } from 'node:sqlite';
import { TurnOutcomeStore } from '../../memory/public/turn-outcome.ts';
import { sessionTurnCompletionDigest } from '../../agent-policy/public/session-turn-completion.ts';
import { nsfwSceneRequestDigest, parseNsfwSceneRequestReceipt,
  type NsfwSceneRequestReceipt } from './nsfw-scene-request.ts';
import { parseNsfwSceneSkillReceipt, type NsfwSceneSkillReceipt } from './nsfw-scene-skill.ts';

export const NSFW_SCENE_RECEIPT_READER_VERSION = 'nsfw-scene-receipt-reader-v1' as const;
const MAX_CREATED_BYTES = 2_097_152;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

function readSnapshot<T>(db: DatabaseSync, read: () => T): T {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    const result = read();
    if (ownsTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction) { try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error;
  }
}

/** This takes a trusted existing SQLite connection; it opens no Session, source, Provider or file. */
export function readNsfwSceneRequestReceipt(
  db: DatabaseSync, sessionId: string, round: number,
): NsfwSceneRequestReceipt | null {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('nsfw-scene-request-round-invalid');
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('nsfw-scene-request-session-invalid');
  return readSnapshot(db, () => {
    const ledger = db.prepare('SELECT created,created_at,user_msg_id,assistant_msg_id FROM round_ledger WHERE round=?')
      .get(round) as { created: string; created_at: string; user_msg_id: number; assistant_msg_id: number } | undefined;
    if (!ledger) return null;
    if (typeof ledger.created !== 'string' || Buffer.byteLength(ledger.created, 'utf8') > MAX_CREATED_BYTES) {
      throw new Error('nsfw-scene-request-native-corrupt');
    }
    const created: unknown = JSON.parse(ledger.created);
    if (!created || typeof created !== 'object' || Array.isArray(created)) throw new Error('nsfw-scene-request-native-corrupt');
    if (!Object.hasOwn(created, 'nsfwSceneRequest')) return null;
    const receipt = parseNsfwSceneRequestReceipt((created as { nsfwSceneRequest: unknown }).nsfwSceneRequest);
    const assistant = db.prepare("SELECT content FROM chat_log WHERE id=? AND round=? AND role='assistant'")
      .get(ledger.assistant_msg_id, round) as { content: string } | undefined;
    const user = db.prepare("SELECT content FROM chat_log WHERE id=? AND round=? AND role='user'")
      .get(ledger.user_msg_id, round) as { content: string } | undefined;
    const store = new TurnOutcomeStore(db);
    const pin = store.readCompletionPin(receipt.runId);
    const proof = store.readCompletionProof(receipt.runId);
    if (receipt.sessionId !== sessionId || receipt.round !== round
      || receipt.assistantMessageId !== ledger.assistant_msg_id || !assistant || !user
      || !pin || !proof || pin.sessionKey !== receipt.sessionId || pin.round !== round
      || pin.historyEpoch !== receipt.historyEpoch || pin.contentMode !== 'nsfw'
      || pin.pinDigest !== (created as { completionPinDigest?: unknown }).completionPinDigest
      || proof.assistantMessageId !== receipt.assistantMessageId || proof.requestDigest !== receipt.requestDigest
      || proof.assistantDigest !== sessionTurnCompletionDigest(assistant.content)
      || receipt.assistantDigest !== nsfwSceneRequestDigest(assistant.content)
      || receipt.inputDigest !== nsfwSceneRequestDigest(user.content)
      || !Number.isFinite(Date.parse(ledger.created_at)) || receipt.createdAt > ledger.created_at) {
      throw new Error('nsfw-scene-request-native-corrupt');
    }
    return receipt;
  });
}

/** Historical parsing never restores the live Skill brand or current execution authority. */
export function readNsfwSceneSkillReceipt(
  db: DatabaseSync, sessionId: string, round: number,
): NsfwSceneSkillReceipt | null {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('nsfw-scene-skill-round-invalid');
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('nsfw-scene-skill-session-invalid');
  return readSnapshot(db, () => {
    const row = db.prepare('SELECT created FROM round_ledger WHERE round=?').get(round) as { created: string } | undefined;
    if (!row) return null;
    if (typeof row.created !== 'string' || Buffer.byteLength(row.created, 'utf8') > MAX_CREATED_BYTES) {
      throw new Error('nsfw-scene-skill-native-corrupt');
    }
    const created: unknown = JSON.parse(row.created);
    if (!created || typeof created !== 'object' || Array.isArray(created)) throw new Error('nsfw-scene-skill-native-corrupt');
    if (!Object.hasOwn(created, 'nsfwSceneSkill')) return null;
    const receipt = parseNsfwSceneSkillReceipt((created as { nsfwSceneSkill: unknown }).nsfwSceneSkill);
    const native = readNsfwSceneRequestReceipt(db, sessionId, round), source = receipt.source;
    if (!native || receipt.nativeReceiptDigest !== native.receiptDigest || receipt.requestDigest !== native.requestDigest
      || receipt.queryHeadDigest !== native.queryHeadDigest || receipt.acceptedAt !== native.createdAt
      || source.sessionId !== native.sessionId || source.runId !== native.runId || source.round !== native.round
      || source.historyEpoch !== native.historyEpoch || source.sourceRevision !== native.sourceRevision
      || source.safetyDigest !== native.safetyDigest || source.sceneDigest !== native.sceneDigest
      || source.decisionDigest !== native.decisionDigest || source.queryHeadDigest !== native.queryHeadDigest
      || nsfwSceneRequestDigest(source.exposureDigests) !== nsfwSceneRequestDigest(native.exposureDigests)) {
      throw new Error('nsfw-scene-skill-native-corrupt');
    }
    return receipt;
  });
}
