/**
 * 临时探针：判断"空返回"是 工具模式×大体量 触发，还是纯粹 大体量 触发。
 * T1: 同 9.8K 内容，不带 tools，要求直接返回 JSON 文本 → 若出话，则走 无工具JSON 方案，无需压体积。
 * T2: 对照：带 tools，同内容 → 预期复现空返回。
 */
import { loadProviderConfig, assertProviderReady } from '../../packages/proxy/src/config.ts';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { storyboardStageTools } from '../../packages/prompt/src/storyboard.ts';
import { readFileSync } from 'node:fs';

const cfg = loadProviderConfig();
assertProviderReady(cfg);
console.log('[probe] provider:', cfg.baseUrl, cfg.model);
const client = new OpenAICompatibleClient(cfg);

const SKILL = readFileSync('data/skills/分镜-逐镜分镜/SKILL.md', 'utf8');
// 构造真正 ~6000 字符的剧情上下文
let ctx = '【近期剧情】\n';
while (ctx.length < 5800) ctx += '玩家: 我说今晚去旧桥见面。\n角色: 她没抬头，雨太冷，信在手里攥皱了。\n';
const CTX6K = ctx.slice(0, 6000);
const SYS = '你是一个分镜专家。\n\n' + SKILL + '\n\n【已发生剧情氛围】\n（无）\n\n【场景背景】\n（无）\n\n导演意图：（测试）\n导演之声：亲密极简';
const USR = '场景：\n深夜雨后的铁桥，她独自站在栏杆边，手里攥着一封没有寄出的信，路灯把道的光芒洒在潮湿的路面。\n\n镜头数共 3 镜。本次只生成第 1~3 镜。每镜严格满足 Shot Contract 字段；positive_prompt 按八段全面精准结构输出（含 positive_prompt_short 简版），narrative_prompt 写清动态因果链。\n\n【额外上下文】\n' + CTX6K;
const tool = Object.values(storyboardStageTools()).find((t) => (t as { function?: { name?: string } }).function?.name === 'storyboard_shots');
const total = SYS.length + USR.length + (tool ? JSON.stringify(tool).length : 0);
console.log('总请求字符(含工具schema):', total, '| tools=', !!tool);

async function run(label: string, withTools: boolean, attempt = 1): Promise<void> {
  try {
    const req = { messages: [{ role: 'system', content: SYS }, { role: 'user', content: USR }], temperature: 0.9 } as Record<string, unknown>;
    if (withTools && tool) { req.tools = [tool]; req.tool_choice = 'auto'; }
    const r = await client.stream(req, () => {});
    console.log(`  [${label}] finish=${r.finishReason || '(空)'} content=${r.content ? r.content.length + '字' : '(无)'} toolCalls=${r.toolCalls.length ? r.toolCalls.map((t) => `${t.name}(${(t.arguments ?? '').length}字)`).join(',') : '(无)'}`);
    if (r.content?.trim().startsWith('{')) console.log('   content 以 { 开头 → 模型直接回了 JSON 文本');
  } catch (e) {
    const msg = (e as Error).message.slice(0, 90);
    console.log(`  [${label}] 尝试${attempt} 抛错: ${msg}`);
    if (/50[0-9]/.test(msg) && attempt < 3) { await run(label, withTools, attempt + 1); }
  }
}

await run('R1 无工具/~9.5K/直回JSON', false);
await run('R2 带工具/~9.5K(对照)', true);
process.exit(0);