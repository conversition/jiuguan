/** @author Codex @date 2026-10-18 @version 1.0
 * Phase F「每轮实际命中与拒绝理由」的只读投影。
 *
 * 数据源**不是新表**：`agent_admission_decision` 早就逐回合记录了
 * verdict / score / hardSignals / reasonCodes / semanticRoute / factsDigest。
 * 这里只把它们按回合列出来，绝不回传 prompt 或模型文本（facts 里也没有正文）。
 *
 * 边界：
 * 1) 只读；不写、不改判、不重新评估；
 * 2) 输出字段是**显式白名单**（不透传整行，避免未来新列被无意暴露）；
 * 3) 未接线（ledger 不存在）⇒ 503，不返回空表冒充「没有决策」。
 */
export interface AdmissionDecisionRowPort {
    readonly decisionId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly round: number;
    readonly createdAt: string;
    readonly decision: Readonly<{
        verdict: string;
        score: number;
        hardSignals: readonly string[];
        reasonCodes: readonly string[];
        semanticRoute: string;
        policyVersion: string;
        factsDigest: string;
    }>;
}

export interface AdmissionDecisionLedgerPort {
    list(filters: { readonly sessionId?: string; readonly runId?: string; readonly limit?: number }):
        readonly AdmissionDecisionRowPort[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

export interface AdmissionDecisionView {
    readonly decisionId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly round: number;
    readonly verdict: string;
    readonly score: number;
    readonly hardSignals: readonly string[];
    readonly reasonCodes: readonly string[];
    readonly semanticRoute: string;
    readonly policyVersion: string;
    readonly factsDigest: string;
    readonly createdAt: string;
}

function view(row: AdmissionDecisionRowPort): AdmissionDecisionView {
    return Object.freeze({
        decisionId: row.decisionId,
        runId: row.runId,
        sessionId: row.sessionId,
        round: Number(row.round),
        verdict: String(row.decision.verdict),
        score: Number(row.decision.score),
        hardSignals: Object.freeze([...row.decision.hardSignals].map(String)),
        reasonCodes: Object.freeze([...row.decision.reasonCodes].map(String)),
        semanticRoute: String(row.decision.semanticRoute),
        policyVersion: String(row.decision.policyVersion),
        factsDigest: String(row.decision.factsDigest),
        createdAt: row.createdAt,
    });
}

export function readAdmissionDecisionsApi(
    ledger: AdmissionDecisionLedgerPort | null,
    query: Readonly<{ sessionId?: string; runId?: string; limit?: string }> = {},
) {
    if (!ledger) return { status: 503, body: { code: 'admission-ledger-unavailable' } };
    let limit: number | undefined;
    if (query.limit !== undefined) {
        if (!/^[0-9]{1,3}$/u.test(query.limit)) {
            return { status: 400, body: { code: 'admission-decisions-request-invalid' } };
        }
        limit = Number(query.limit);
        if (limit < 1 || limit > 128) {
            return { status: 400, body: { code: 'admission-decisions-request-invalid' } };
        }
    }
    for (const value of [query.sessionId, query.runId]) {
        if (value !== undefined && !TOKEN.test(value)) {
            return { status: 400, body: { code: 'admission-decisions-request-invalid' } };
        }
    }
    try {
        const rows = ledger.list({
            ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
            ...(query.runId === undefined ? {} : { runId: query.runId }),
            ...(limit === undefined ? {} : { limit }),
        });
        return { status: 200, body: { decisions: rows.map(view) } };
    } catch {
        // 读取失败绝不降级成空列表：那会让操作者以为「这一回合没有决策」。
        return { status: 503, body: { code: 'admission-decisions-unavailable' } };
    }
}

export const ADMISSION_DECISIONS_ROUTE = '/api/agent/admission-decisions';
