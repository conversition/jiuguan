#!/usr/bin/env node
/**
 * tools/cli - 文风层验证（skill schema 扩展 / 底座默认 / 激活文风全量注入 / 词条 skill 去重 / 稳定前缀）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-style.ts
 */
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSkillMd, addSkill, findSkill, readSkillBody, listSkills, listStyleSkills, getDefaultStyleSkill, syncStylesFromSource,
  type StyleSkillSpec,
} from '../../packages/core/src/skills.ts';
import { assembleTurn, DEFAULT_SYSTEM_CORE } from '../../packages/prompt/src/assembly.ts';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; console.log(`  ✅ ${msg}`); } else { fail++; console.log(`  ❌ ${msg}`); } };

// 隔离目录（不污染 data/skills）
const DIR = join('data', 'skills-style-test');
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// 1. schema 扩展：role/default/nsfw/source/sourceHash/styleId 透传
const blade = addSkill({ name: '文风-底座-轻小说', description: '默认底座', content: '## 文风基调\n轻小说。', keywords: ['轻小说', '默认'], role: 'style', default: true, source: 'x#1', sourceHash: 'h1', styleId: '1', enabled: true }, DIR);
ok(blade.role === 'style' && blade.default === true && blade.styleId === '1', 'addSkill 透传 role/default/sourceHash/styleId');
const nsfw = addSkill({ name: '文风-NSFW', description: 'nsfw', content: '官能。', role: 'style', nsfw: true, source: 'x#2', sourceHash: 'h2' }, DIR);
ok(nsfw.nsfw === true, 'addSkill 透传 nsfw');
ok(addSkill({ name: '战斗描写', description: '打斗', content: '短句。', role: 'tactical' }, DIR).role === 'tactical', '战术 skill role=tactical');

// 2. listSkills 解析新字段 / listStyleSkills / getDefaultStyleSkill
const all = listSkills(DIR);
ok(all.find((s) => s.name === '文风-底座-轻小说')?.default === true, 'listSkills 解析 default');
const styles = listStyleSkills(DIR);
ok(styles.length === 2 && styles.every((s) => s.role === 'style'), 'listStyleSkills 只返回 role=style');
ok(getDefaultStyleSkill(DIR)?.name === '文风-底座-轻小说', 'getDefaultStyleSkill 命中 default:true');

// 3. syncStylesFromSource：同 hash 跳过；hash 变则更新
const spec: StyleSkillSpec = { name: '文风-底座-轻小说', description: '默认底座', body: '## 文风基调\n轻小说。', keywords: ['轻小说'], role: 'style', default: true, source: 'x#1', sourceHash: 'h1', styleId: '1' };
ok(syncStylesFromSource([spec], DIR).unchanged.length === 1, '同 sourceHash 不变 → unchanged');
ok(syncStylesFromSource([{ ...spec, body: '## 文风基调\n轻小说（改）', sourceHash: 'h2' }], DIR).updated.length === 1, 'sourceHash 变 → updated');
ok(readSkillBody('文风-底座-轻小说', DIR).includes('（改）'), 'updated 后正文为新内容');
ok(syncStylesFromSource([{ ...spec, name: '文风-新风格', source: 'x#3', sourceHash: 'h3', styleId: '3', default: false }], DIR).created.length === 1, '新 spec → created');

// 4. 真实 data/skills 产物（import-style 已跑）：默认底座存在、文风库 34 作者风格 + NSFW 生成、全量正文
const realBase = readSkillBody('文风-底座-轻小说');
ok(realBase.includes('详细缓慢') || realBase.includes('节奏'), '真实默认底座含慢节奏/详细要求');
const realStyles = listStyleSkills();
ok(realStyles.length >= 36, `真实文风库导入：style skill ≥36（=34 作者 + 底座 + NSFW），实际 ${realStyles.length}`);
ok(findSkill('文风-青春暧昧日常轻小说-入間人間') !== null, '文风-入間人間 已生成');
ok(readSkillBody('文风-青春暧昧日常轻小说-入間人間').includes('<style_anchors'), '作者风格全量注入（含原始指令正文）');
ok(findSkill('文风-NSFW')?.nsfw === true, '文风-NSFW 已生成且 nsfw=true');

// 5. assembleTurn：styleBlock 进 system 稳定前缀（<文风指令>），动态项不入稳定前缀
const custom = {
  role: 'style', default: false, nsfw: false, source: 'x#4', sourceHash: 'h4', styleId: '4',
};
const styleBody = '## 文风\n慢节奏。';
addSkill({ name: '手写-文风', description: '', content: styleBody, ...custom, enabled: true }, DIR); // 已解析
const assembled = assembleTurn({
  systemCore: DEFAULT_SYSTEM_CORE,
  staticSettings: '角色卡：测试',
  styleBlock: `<文风底座>\n${styleBody}\n</文风底座>`,
  userInput: '<最新互动>\n你好\n</最新互动>',
  useTools: false,
});
const systemMsg = assembled.messages[0].content;
ok(systemMsg.includes('<文风指令>') && systemMsg.includes('慢节奏'), 'styleBlock 渲染进 system <文风指令>');
ok(assembled.messages[0].role === 'system' && assembled.messages[assembled.messages.length - 1].role === 'user', '稳定前缀在 system，输入在 user');

// 6. 战术 skill（matchSkills 反应式）不受影响：文风控制 仍在（战术层）
ok(findSkill('文风控制') !== null, '战术级 文风控制 skill 仍存在');

console.log(`\n[文风] ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);

// 清理隔离目录
rmSync(DIR, { recursive: true, force: true });
