#!/usr/bin/env node
// -*- coding:utf-8 -*-
// @author  : claude
// @time    : 2026-08-28 12:55
// @function: E2E 验证停止生成全链路（真实 HTTP/SSE：前端 abort → 后端 req close → 上游中止 → 部分正文落库 → 幂等兜底 → 停止后立即可再发）
// @version : v1.0
// @modify  : 2026-08-28 claude 初版
//
// 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-abort-e2e.ts
// 架构：mock OpenAI 兼容上游（慢速流式吐 game_turn 参数，记录被中止时刻）
//       + jiuguan server 子进程（隔离端口 17990 / JG_PROVIDER_JSON 临时文件）
//       + Node fetch 模拟浏览器端停止行为（AbortController 中途 abort）

import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';

const ROOT = resolve(import.meta.dirname, '../..');
const SERVER_PORT = 17990;
const MOCK_PORT = 17991;
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
/** 上游流式节奏：每块间隔 ms（总时长 ≈ 块数 × 间隔，保证中途 abort 有意义） */
const MOCK_CHUNK_INTERVAL_MS = 120;
/** mock 单次上游调用持续上限（异常兜底，防测试挂死） */
const MOCK_MAX_CHUNKS = 200;

// ── 断言工具 ──
let failures = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
    console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${extra}`}`);
    if (!cond) failures++;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── mock 上游（OpenAI 兼容 /v1/chat/completions SSE）──
interface MockState {
    requests: number;
    /** 上游被中止时已吐出的块数（-1 = 本次未中止/正常完成） */
    abortedAtChunk: number;
    /** 最近一次请求是否正常吐完（writableEnded） */
    completed: boolean;
}
const mockState: MockState = { requests: 0, abortedAtChunk: -1, completed: false };

const buildGameTurnArgs = (): string => JSON.stringify({
    // prose 放首字段且加长：对齐真实模型（正文参数流式分片从早期持续产生，客户端能流中段中止）
    prose: '这是 E2E 验证的流式正文，逐块发往前端。'.repeat(40),
    plan: { thought: '测试', key_events: [{ description: '测试事件' }], next_plan: '继续', event_type: 'normal', bars_delta: { personal: 3 } },
    memory_delta: { delta_summary: 'E2E摘要', state_changes: [], new_events: [] },
});

const startMockUpstream = (): Promise<http.Server> => new Promise((resolveMock) => {
    const mock = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => { body += c.toString(); });
        req.on('end', () => {
            mockState.requests++;
            mockState.abortedAtChunk = -1;
            mockState.completed = false;
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            // 首块带 id+name，后续块只带 arguments 分片（对齐真实上游 tool_calls 流式协议）
            const pieces = buildGameTurnArgs().match(/[\s\S]{1,30}/g) ?? [];
            let sent = 0;
            const timer = setInterval(() => {
                if (res.writableEnded || res.destroyed || sent >= MOCK_MAX_CHUNKS) {
                    clearInterval(timer);
                    return;
                }
                const arg = pieces[sent] ?? '';
                const toolCall = sent === 0
                    ? { index: 0, id: 'tc-e2e', function: { name: 'game_turn', arguments: arg } }
                    : { index: 0, function: { arguments: arg } };
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\n`);
                sent++;
                if (sent >= pieces.length) {
                    clearInterval(timer);
                    res.write('data: [DONE]\n\n');
                    res.end(() => { mockState.completed = true; });
                }
            }, MOCK_CHUNK_INTERVAL_MS);
            res.on('close', () => {
                // 客户端（jiuguan server）断开且未正常结束 → 上游被中止，记录已吐块数
                if (!res.writableEnded) mockState.abortedAtChunk = sent;
                clearInterval(timer);
            });
        });
    });
    mock.listen(MOCK_PORT, '127.0.0.1', () => resolveMock(mock));
});

// ── SSE 客户端（对齐 App.tsx apiStream：data: 行解析 + signal 中止）──
const readSSE = async (
    path: string, reqBody: Record<string, unknown>,
    onEvent: (ev: Record<string, unknown>) => void, signal?: AbortSignal,
): Promise<void> => {
    const res = await fetch(`${SERVER}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal,
    });
    if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(String(err.error ?? `HTTP ${res.status}`));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            try { onEvent(JSON.parse(t.slice(5).trim())); } catch { /* 忽略坏块 */ }
        }
    }
};

const jsonApi = async <T,>(path: string, reqBody?: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${SERVER}${path}`, {
        method: reqBody === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody === undefined ? undefined : JSON.stringify(reqBody),
    });
    const data = await res.json() as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
};

// ── 主流程 ──
let serverProc: ReturnType<typeof spawn> | null = null;
const serverLogs: string[] = [];

async function main(): Promise<void> {
    // 1. mock 上游
    const mock = await startMockUpstream();

    // 2. 临时 provider.json 指向 mock（JG_PROVIDER_JSON 隔离，不污染 data/provider.json）
    const providerFile = join(tmpdir(), `jg-provider-e2e-${Date.now()}.json`);
    writeFileSync(providerFile, JSON.stringify({
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'sk-e2e-mock', model: 'e2e-mock-model', kind: 'openai',
    }));

    // 3. jiuguan server 子进程（隔离端口）
    serverProc = spawn(process.execPath, [
        '--experimental-strip-types', '--experimental-transform-types', 'apps/server/server.ts',
    ], {
        cwd: ROOT,
        env: { ...process.env, JG_WEB_PORT: String(SERVER_PORT), JG_PROVIDER_JSON: providerFile },
    });
    serverProc.stdout?.on('data', (d: Buffer) => serverLogs.push(...d.toString().split('\n').filter(Boolean)));
    serverProc.stderr?.on('data', (d: Buffer) => serverLogs.push(...d.toString().split('\n').filter(Boolean).map((l) => `[stderr] ${l}`)));

    // 等就绪（轮询 /api/cards）
    let ready = false;
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(`${SERVER}/api/cards`);
            ready = true;
            break;
        } catch { await sleep(500); }
    }
    check('server 启动就绪', ready);
    if (!ready) { dumpLogs(); return; }

    // 4. 新会话（SSE 读 ready 事件拿 id）
    const cardFile = '0e3osp.json';
    if (!existsSync(join(ROOT, 'data', 'cards', cardFile))) {
        check(`测试卡存在 ${cardFile}`, false);
        return;
    }
    let sid = '';
    await readSSE('/api/session/new', { card: cardFile, content_mode: 'nsfw' }, (ev) => {
        if (ev.type === 'ready') sid = String(ev.id);
        if (ev.type === 'error') throw new Error(String(ev.message));
    });
    check('会话创建成功', sid.length > 0, `sid=${sid}`);
    if (!sid) { dumpLogs(); return; }

    // ── 场景 A：turn 流式中途停止（前端停止按钮行为）──
    mockState.requests = 0;
    const acA = new AbortController();
    let deltasA = 0;
    let abortErrName = '';
    try {
        await readSSE('/api/turn', { session: sid, input: '你好，开始第一回合', content_mode: 'nsfw' }, (ev) => {
            if (ev.type === 'delta') {
                deltasA++;
                // 收到第 2 个 delta 即模拟用户点停止
                if (deltasA === 2) acA.abort();
            }
        }, acA.signal);
    } catch (e) {
        abortErrName = (e as Error).name;
    }
    check('A1 中途停止：前端 fetch 抛 AbortError', abortErrName === 'AbortError', `name=${abortErrName}`);

    // 等后端中止传播 + 兜底落库窗口
    await sleep(2500);
    check('A2 后端中止上游连接（mock 收到断开）', mockState.abortedAtChunk > 0,
        `abortedAtChunk=${mockState.abortedAtChunk} completed=${mockState.completed} requests=${mockState.requests}`);

    // A3：history 应有 round1 assistant（部分正文或占位符，绝不能缺行）；修复后应为部分正文
    interface HistoryMsg { round: number; role: string; content: string }
    const h1 = await jsonApi<{ messages: HistoryMsg[] }>(`/api/session/${sid}/history`);
    const assist1 = h1.messages.find((m) => m.round === 1 && m.role === 'assistant');
    check('A3 round1 assistant 已落库（部分正文/占位）', Boolean(assist1),
        `history=${JSON.stringify(h1.messages.map((m) => [m.round, m.role, m.content.slice(0, 30)]))}`);
    check('A3b 落库为部分正文（非占位符）', Boolean(assist1 && assist1.content.includes('流式正文')),
        `content=${(assist1?.content ?? '').slice(0, 40)}`);

    // A4：/turn/abort 幂等兜底（前端 finalizeAbort 行为；此时已由中止路径落库 → kept=false）
    const ab1 = await jsonApi<{ ok: boolean; kept: boolean }>(`/api/session/${sid}/turn/abort`, { round: 1 });
    check('A4 /turn/abort 幂等（已落库跳过）', ab1.ok === true && ab1.kept === false, JSON.stringify(ab1));

    // ── 场景 B：停止后立即可再发（第二个 turn 完整跑完）──
    mockState.requests = 0;
    let doneB = false;
    let proseB = '';
    let errB = '';
    try {
        await readSSE('/api/turn', { session: sid, input: '继续第二回合', content_mode: 'nsfw' }, (ev) => {
            if (ev.type === 'done') { doneB = true; proseB = String(ev.prose ?? ''); }
            if (ev.type === 'error') errB = String(ev.message ?? '');
        });
    } catch (e) { errB = (e as Error).message; }
    check('B1 停止后第二个 turn 正常完成', doneB && !errB, `done=${doneB} err=${errB}`);
    check('B2 第二个 turn 拿到完整 prose', proseB.includes('最终正文') || proseB.includes('流式正文'), `prose=${proseB.slice(0, 50)}`);
    check('B3 第二个 turn 走了完整上游流（未被中止）', mockState.completed && mockState.abortedAtChunk === -1,
        `completed=${mockState.completed} abortedAtChunk=${mockState.abortedAtChunk}`);

    // B4：round2 assistant 完整落库
    const h2 = await jsonApi<{ messages: HistoryMsg[] }>(`/api/session/${sid}/history`);
    const assist2 = h2.messages.find((m) => m.round === 2 && m.role === 'assistant');
    check('B4 round2 assistant 完整落库', Boolean(assist2 && assist2.content.includes('流式正文')),
        `content=${(assist2?.content ?? '').slice(0, 50)}`);

    // ── 场景 C：对已完整轮调用 /turn/abort（页面刷新后兜底路径的幂等）──
    const ab2 = await jsonApi<{ ok: boolean; kept: boolean }>(`/api/session/${sid}/turn/abort`, { round: 2 });
    check('C1 已完整轮 /turn/abort 幂等跳过', ab2.ok === true && ab2.kept === false, JSON.stringify(ab2));
    // C2：非法 round 校验
    let c2err = '';
    try { await jsonApi(`/api/session/${sid}/turn/abort`, { round: 0 }); } catch (e) { c2err = (e as Error).message; }
    check('C2 round=0 拒绝', c2err.includes('round'), `err=${c2err}`);

    // ── 场景 D：并发守卫（回合进行中发新回合 → 快速拒绝，且不破坏在跑回合）──
    mockState.requests = 0;
    let doneD = false;
    let errD = '';
    const acD1 = new AbortController();
    // 主回合：不停止，跑完整流程
    const turnD = readSSE('/api/turn', { session: sid, input: '并发守卫测试主回合', content_mode: 'nsfw' }, (ev) => {
        if (ev.type === 'done') doneD = true;
        if (ev.type === 'error') errD = String(ev.message ?? '');
    }, acD1.signal);
    // 等主回合真正进入流式（mock 已开始吐块）后再并发发第二个
    await sleep(400);
    let busyErr = '';
    await readSSE('/api/turn', { session: sid, input: '并发插入回合', content_mode: 'nsfw' }, (ev) => {
        if (ev.type === 'error') busyErr = String(ev.message ?? '');
    });
    await turnD;
    // D 断言：主回合不受并发插入影响（完整完成）；并发插入被明确拒绝
    check('D1 主回合并发插入下仍完整完成', doneD && !errD, `done=${doneD} err=${errD}`);
    check('D1b 并发插入被守卫拒绝', busyErr.includes('生成中'), `err=${busyErr}`);
    check('D2 上游两次调用均未被误中止', mockState.abortedAtChunk === -1,
        `abortedAtChunk=${mockState.abortedAtChunk} requests=${mockState.requests}`);

    // D3：并发插入轮未留下脏数据（round 序列连续、无孤儿 user；round 0 为开场白 assistant，排除）
    const h3 = await jsonApi<{ messages: HistoryMsg[] }>(`/api/session/${sid}/history`);
    const roundsUser = h3.messages.filter((m) => m.role === 'user' && m.round > 0).map((m) => m.round).sort((a, b) => a - b);
    const roundsAssist = h3.messages.filter((m) => m.role === 'assistant' && m.round > 0).map((m) => m.round).sort((a, b) => a - b);
    const paired = roundsUser.length === roundsAssist.length && roundsUser.every((r, i) => r === roundsAssist[i]);
    check('D3 user/assistant 轮成对无孤儿', paired,
        `user=[${roundsUser}] assist=[${roundsAssist}]`);

    // ── 场景 E：regenerate 中途停止（round 已知路径）──
    mockState.requests = 0;
    const acE = new AbortController();
    let deltasE = 0;
    let abortEName = '';
    try {
        await readSSE(`/api/session/${sid}/regenerate`, { round: 3 }, (ev) => {
            if (ev.type === 'delta') {
                deltasE++;
                if (deltasE === 2) acE.abort();
            }
        }, acE.signal);
    } catch (e) { abortEName = (e as Error).name; }
    check('E1 regenerate 中途停止抛 AbortError', abortEName === 'AbortError', `name=${abortEName}`);
    await sleep(2500);
    check('E2 regenerate 中止上游连接', mockState.abortedAtChunk > 0, `abortedAtChunk=${mockState.abortedAtChunk}`);
    // E3：前端幂等兜底（regenerate 的 AbortError 分支会传 msg.round）
    const abE = await jsonApi<{ ok: boolean; aborted: boolean; kept: boolean }>(`/api/session/${sid}/turn/abort`, { round: 3 });
    check('E3 /turn/abort 幂等（已落库跳过）', abE.ok === true && abE.kept === false, JSON.stringify(abE));
    const h4 = await jsonApi<{ messages: HistoryMsg[] }>(`/api/session/${sid}/history`);
    const assistE = h4.messages.find((m) => m.round === 3 && m.role === 'assistant');
    check('E4 round3 assistant 已落库（部分正文/占位）', Boolean(assistE), `content=${(assistE?.content ?? '').slice(0, 30)}`);

    // 清理测试 db（data/ 下 server 命名的会话库）
    const dbFile = join(ROOT, 'data', `${sid}.db`);
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
        try { if (existsSync(f)) rmSync(f); } catch { /* 忽略 */ }
    }
    try { rmSync(providerFile); } catch { /* 忽略 */ }

    console.log(failures === 0 ? '\n停止生成 E2E 全链路验证通过 ✅' : `\n${failures} 项失败 ❌`);
    if (failures > 0) dumpLogs();
    process.exit(failures === 0 ? 0 : 1);
}

function dumpLogs(): void {
    console.log('\n── server 子进程日志（尾部 60 行）──');
    for (const l of serverLogs.slice(-60)) console.log(`  | ${l}`);
}

// 全局兜底超时：防挂死（3 分钟）
const globalTimer = setTimeout(() => {
    console.error('❌ E2E 全局超时（180s），强制退出');
    dumpLogs();
    serverProc?.kill();
    process.exit(1);
}, 180_000);
globalTimer.unref();

await main();
