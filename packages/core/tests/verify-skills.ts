#!/usr/bin/env node
/**
 * core 包 - Skill 系统验证（公共格式扫描 / 解析 / 增删 / 语义匹配）
 * 运行：node --experimental-strip-types --experimental-transform-types packages/core/tests/verify-skills.ts
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  parseSkillMd, renderSkillMd, listSkills, addSkill, setSkillEnabled, deleteSkill,
  readSkillBody, matchSkills, renderSkillBlock,
} from '../src/skills.ts';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; console.log(`  ✅ ${msg}`); } else { fail++; console.log(`  ❌ ${msg}`); } };

// 隔离测试目录（避免污染 data/skills）
const DIR = join('data', 'skills-test');
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

console.log('== SKILL.md 公共格式解析 ==');
const md = `---
name: 文风控制
description: 需要调整正文文风或模仿作家风格时使用
version: 1.0
enabled: true
---

## 规则
1. 短句用于紧张场景
2. 感官优先
`;
const { meta, body } = parseSkillMd(md);
ok(meta.name === '文风控制', 'frontmatter name 解析');
ok(meta.description.includes('文风'), 'frontmatter description 解析');
ok(meta.enabled === 'true', 'frontmatter enabled 解析');
ok(body.includes('短句用于紧张场景'), '正文提取（frontmatter 剥离）');

console.log('== 渲染往返 ==');
const rendered = renderSkillMd('文风控制', 'desc', '1.0', true, 'body-text');
const rp = parseSkillMd(rendered);
ok(rp.meta.name === '文风控制' && rp.body === 'body-text', 'render → parse 往返一致');

console.log('== 增删改 ==');
const s = addSkill({ name: '战斗描写', description: '战斗/打斗场景需要动感分镜时使用', content: '写战斗：短句+动作链+环境反馈' }, DIR);
ok(s.name === '战斗描写' && existsSync(join(DIR, '战斗描写', 'SKILL.md')), 'addSkill 落盘');
let skills = listSkills(DIR);
ok(skills.length === 1 && skills[0].name === '战斗描写', 'listSkills 扫描公共格式目录');
ok(readSkillBody('战斗描写', DIR).includes('短句+动作链'), 'readSkillBody 读正文');
const dis = setSkillEnabled('战斗描写', false, DIR);
ok(dis.enabled === false, 'setSkillEnabled 停用');
ok(listSkills(DIR)[0].enabled === false, '停用持久化到 frontmatter');
deleteSkill('战斗描写', DIR);
ok(!existsSync(join(DIR, '战斗描写')), 'deleteSkill 删除');
skills = listSkills(DIR);
ok(skills.length === 0, '删除后列表为空');

console.log('== 语义匹配（并行 AI 自觉）==');
addSkill({ name: '战斗描写', description: '打斗、对抗、动作场面需要动感分镜时使用', keywords: ['战斗', '打斗', '一刀', '劈', '杀'], content: '战斗分镜' }, DIR);
addSkill({ name: '文风控制', description: '调整文风、风格、让文字更有张力时使用', keywords: ['文风', '风格', '平淡', '张力'], content: '文风规则' }, DIR);
const q1 = matchSkills('他拔出刀，一刀劈向对方', { dir: DIR, threshold: 0.15 });
ok(q1.length > 0 && q1.some((m) => m.skill.name === '战斗描写'), `战斗输入命中「战斗描写」（得 ${q1.map((m) => `${m.skill.name}:${m.score.toFixed(2)}`).join(',')}）`);
const q2 = matchSkills('这段写得太平淡了，帮我改得有张力一点', { dir: DIR, threshold: 0.15 });
ok(q2.some((m) => m.skill.name === '文风控制'), `文风输入命中「文风控制」`);
const q3 = matchSkills('今天晚饭吃什么', { dir: DIR, threshold: 0.15 });
ok(q3.length === 0, '无关输入零命中');
const block = renderSkillBlock(q1);
ok(block.includes('<Skill 指令>') && block.includes('战斗描写'), 'renderSkillBlock 注入块格式');

// 清理
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
