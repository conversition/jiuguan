import { createProseStreamExtractor } from '../src/turn.ts';

// 模拟模型流式输出 game_turn 工具参数：plan → memory_delta → prose（含转义引号/反斜杠/换行）
const obj = {
  plan: { key_events: [{ description: 'x' }] },
  memory_delta: { delta_summary: '变化' },
  prose: '风灌进领口，Soyo 没动。她"低声"说：\\"你还要我怎样？\\"\n第二段。',
};
const full = JSON.stringify(obj);
const expected = obj.prose;

// 分片：每 8 字符一片，模拟 SSE delta 逐字到达
const extractor = createProseStreamExtractor();
let out = '';
for (let i = 0; i < full.length; i += 8) {
  const frag = extractor(full.slice(i, i + 8));
  if (frag) out += frag;
}
const ok = out === expected;
console.log('分片8 提取 == 原文?', ok ? '✅' : '❌');
if (!ok) {
  console.log('  原文   :', JSON.stringify(expected));
  console.log('  提取   :', JSON.stringify(out));
}

// 分片 1 字符（最细粒度）
const e1 = createProseStreamExtractor();
let out1 = '';
for (let i = 0; i < full.length; i += 1) {
  const frag = e1(full.slice(i, i + 1));
  if (frag) out1 += frag;
}
console.log('分片1 提取 == 原文?', out1 === expected ? '✅' : '❌');

// 无 prose 字段 → 空
const e2 = createProseStreamExtractor();
const g = e2(JSON.stringify({ plan: {}, memory_delta: {} }));
console.log('无 prose 字段 → 空?', g === '' ? '✅' : '❌');

// prose 为最后一个字段但后随 }, （模拟完整闭合）
const e3 = createProseStreamExtractor();
const withClose = JSON.stringify({ plan: {}, memory_delta: {}, prose: '正文内容' }) + '}\n\n';
let out3 = '';
for (let i = 0; i < withClose.length; i += 5) {
  const frag = e3(withClose.slice(i, i + 5));
  if (frag) out3 += frag;
}
console.log('带闭合 prose 提取?', out3 === '正文内容' ? '✅' : '❌', JSON.stringify(out3));

process.exit(0);
