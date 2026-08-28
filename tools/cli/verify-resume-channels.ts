/**
 * tools/cli - verify-resume-channels：服务重启恢复会话后检索渠道恢复验证
 *
 * 根因：/api/session/resume 重建 ChatSession 不传 card → init() 只在卡片分支调 loadWorldbooks，
 *       而 bge 注入/PG 关联/语义激活只存在于 loadWorldbooks 尾部 → 恢复会话通道0(别名)/通道B(ANN)
 *       全灭、检索恒 0 条（世界书 SQLite 扫描不受影响，状态行只见「检索0条/世界书N条」）。
 * 修复：渠道初始化抽为 initRetrievalChannels()，init() 末尾无条件执行。
 *
 * 验证（resume 模式、不传 card）：
 *   ① useBge=true：embedProvider 已注入（bge 优先，缺模型回落 hash——两者都是渠道恢复）
 *   ② PG 就绪时 pgStore 已关联（修复前恒 null）
 *   ③ PG 就绪时补索引后 recallAsync 命中 >0 且含别名/向量通道
 *   ④ 无启用条目：hash 兜底（原 vectorizable=false 路径保持）
 *   ⑤ useBge=false 且有条目：不设 provider（原行为保持）
 *
 * 用法：npx tsx tools/cli/verify-resume-channels.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { getPgVectorStore } from '../../packages/memory/src/pg-vector.ts';
import { indexSessionLore } from './lore-index-task.ts';
import { ChatSession, type SessionArgs } from './session.ts';

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, extra = ''): void {
    if (ok) { passCount++; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`); }
    else { failCount++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

/** 预置一个"此前对话过"的会话库（resume 场景：lorebook_entry 已持久在 SQLite） */
function seedLore(dbPath: string): void {
    const mem = new MemoryDb({ path: dbPath });
    mem.db.prepare(
        'INSERT INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run('u1', '验证书', '桐月樱佳,会长', '桐月樱佳',
        '桐月樱佳是学生会的会长，冷静自持，口头禅是「规矩就是规矩」。验证用设定文本，需要超过索引的最低长度门槛。'.repeat(4),
        0, 4, 0, 0, '', 100, 1, 1);
    mem.close();
}

async function main(): Promise<void> {
    console.log('═'.repeat(62));
    console.log('verify-resume-channels — resume 会话检索渠道恢复');
    console.log('═'.repeat(62));
    const dir = mkdtempSync(join(tmpdir(), 'verify-resume-channels-'));
    try {
        // ① 核心：resume 不传 card，渠道仍恢复
        const dbPath = join(dir, 'session-resume.db');
        seedLore(dbPath);
        const session = new ChatSession({ db: dbPath, resume: true, useBge: true } as SessionArgs);
        await session.init();
        const ret = (session as unknown as { ret: { embedProvider: { name: string } | null; pgStore: unknown } }).ret;
        const provider = ret.embedProvider;
        check('① resume 无 card：embedProvider 已注入', provider !== null,
            provider ? `provider=${provider.name}` : 'null（渠道未恢复）');

        // ③ PG 关联 + 召回（PG 不可用时降级说明，不算失败——渠道注入已由①覆盖）
        const pg = await getPgVectorStore();
        if (pg.isReady) {
            check('② resume 无 card：pgStore 已关联', ret.pgStore !== null);
            const ns = 'session-resume';
            const embedder = provider && provider.name === 'bge' ? provider : null;
            await indexSessionLore(
                (session as unknown as { mem: MemoryDb }).mem, pg, ns,
                embedder as unknown as Parameters<typeof indexSessionLore>[3],
            );
            const result = await (session as unknown as { ret: { recallAsync(q: { query: string; round: number; budgetTokens: number; namespace: string }): Promise<{ hits: { source: string }[] }> } }).ret
                .recallAsync({ query: '会长', round: 1, budgetTokens: 3000, namespace: ns });
            check('③ recallAsync 命中 >0', result.hits.length > 0, `hits=${result.hits.length} sources=[${result.hits.map((h) => h.source).join(',')}]`);
            const hasHighChannel = result.hits.some((h) => h.source === 'alias' || h.source === 'vec');
            check('③b 别名/向量通道参与召回', hasHighChannel);
        } else {
            console.log('  ⚠️ PG 未就绪，跳过 ②③（pgStore 关联/召回断言；渠道注入已由①覆盖）');
        }

        // ④ 无启用条目 → hash 兜底
        const emptyPath = join(dir, 'session-empty.db');
        const emptySession = new ChatSession({ db: emptyPath, resume: true, useBge: true } as SessionArgs);
        await emptySession.init();
        const emptyProvider = (emptySession as unknown as { ret: { embedProvider: { name: string } | null } }).ret.embedProvider;
        check('④ 无启用条目：hash 兜底', emptyProvider !== null && emptyProvider.name.startsWith('hash'),
            emptyProvider ? `provider=${emptyProvider.name}` : 'null');

        // ⑤ useBge=false 且有条目 → 不设 provider（原行为保持）
        const noBgePath = join(dir, 'session-nobge.db');
        seedLore(noBgePath);
        const noBgeSession = new ChatSession({ db: noBgePath, resume: true, useBge: false } as SessionArgs);
        await noBgeSession.init();
        const noBgeProvider = (noBgeSession as unknown as { ret: { embedProvider: { name: string } | null } }).ret.embedProvider;
        check('⑤ useBge=false：不设 provider（原行为）', noBgeProvider === null,
            noBgeProvider ? `provider=${noBgeProvider.name}（应保持 null）` : 'null');

    } finally {
        // Windows：SQLite 连接未显式关闭时文件可能仍被锁——清理失败不掩盖验证结果
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统临时目录回收 */ }
    }
    console.log('═'.repeat(62));
    console.log(`通过 ${passCount} / 失败 ${failCount}`);
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
