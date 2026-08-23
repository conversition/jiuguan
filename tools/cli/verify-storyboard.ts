/**
 * tools/cli 验证 - 导演分镜编排器（Commit B）
 * 无模型 mock 端到端：工作流 yaml 解析 → 召回 → 四阶段（读本/逐镜/串联/人类化）→ 五级校验 → 落库。
 * 用 MockClient 提供各阶段结构化输出（绕过 API 限流）。
 */
import { readFileSync } from 'node:fs';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { HashEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { safeParseStage, validatePanels, validateSequence, DirectorsReadSchema, PanelsSchema } from '../../packages/prompt/src/storyboard.ts';
import { parseWorkflowYaml, StoryboardOrchestrator, STORYBOARD_WORKFLOWS_DIR } from './storyboard-orchestrator.ts';
import type { StoryboardDeps } from './storyboard-orchestrator.ts';
import type { ChatRequest, ChatResponse } from '../../packages/proxy/src/client.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

// ── 夹具 ──
const readFixture = {
  function: '收束', turn: '从回避到相拥', pov: '祥子体验内部', power: '意愿vs重量反复易手',
  subtext: '拥抱是不敢松手', intention: '让观众感受到依存的重量', voice: '亲密极简',
};
const seqFixture = {
  master_prompt: '整体分镜概括（含统一视觉锚点表）', rhythm_map: '节奏地图', narrative: '逐镜串联描述',
  consistency: '角色一致性锁定', sfx: '环境音+动作音，无音乐', checklist: '节奏校验逐项通过',
};
const humanizeFixture = {
  function: '收束', turn: '从回避到相拥', pov: '祥子体验', power: '重量易手', subtext: '不敢松手', intention: '依存的重量',
  master_desc: '序列整体描述改写', narrative: '逐镜串联描述改写', summary: '去除AI痕迹', scores: { directness: 9, rhythm: 8, trust: 8, authenticity: 8, concision: 8 },
};

function mkPanel(n: number) {
  const common = 'the frame shows the two figures on the wet grate beneath the night sky';
  return {
    panel: n,
    time: `${2 + n * 0.5}s`,
    shot_size: 'medium wide',
    angle: n % 2 ? 'profile' : 'eye-level',
    lens_feel: 'natural 35mm perspective',
    camera_support: 'locked-off',
    movement: 'push-in',
    subject_relation: 'holds',
    start_frame: '可读起帧构图',
    end_frame: '变化后的终帧',
    fragile_anchors: 'yellow eyes / red bracelet / black cap',
    canvas: { width: 1536, height: 1024, ratio: '3:2' },
    camera: 'low side framing along the railing line',
    lighting: 'warm golden street lamps key against cool night blue fill',
    focus: 'sharp on the faces, soft skyline',
    positive_prompt: `${common}, warm lamp reflections stretching across wet steel, cool blue night shadows, crisp foreground wet grate, soft distant skyline`,
    positive_prompt_short: 'Two figures hold on the wet bridge, lamp gold against night blue.',
    negative_prompt: 'lowres, bad anatomy, extra fingers, watermark',
    nltags_sentences: ['the wet grate holds stretched lamp reflections', 'the figures stay frozen mid-gesture', 'the night sky fills the upper frame'],
    narrative_prompt: 'The two figures shift weight on the wet grate as the lamp light slides across the metal and the silence holds between them, one breath passing into the next.',
    transition_hint: 'hard cut on the held gaze',
  };
}
const PANELS = [1, 2, 3, 4, 5].map(mkPanel);

// ── Mock 客户端（结构对齐 OpenAICompatibleClient.stream / complete）──
class MockClient {
  calls: string[] = [];
  private canned(): Record<string, string> {
    return {
      storyboard_read: JSON.stringify(readFixture),
      storyboard_shots: JSON.stringify({ panels: PANELS }),
      storyboard_link: JSON.stringify(seqFixture),
      storyboard_humanize: JSON.stringify(humanizeFixture),
    };
  }
  private toolName(req: ChatRequest): string {
    return ((req.tools?.[0] as { function?: { name?: string } } | undefined)?.function?.name) ?? '';
  }
  async complete(req: ChatRequest): Promise<ChatResponse> {
    const tool = this.toolName(req);
    this.calls.push(tool);
    return { content: null, toolCalls: [{ id: 'c1', name: tool, arguments: this.canned()[tool] ?? '{}' }], finishReason: 'tool_calls', usage: null, raw: '' };
  }
  async stream(req: ChatRequest, _onDelta: (d: string) => void): Promise<ChatResponse> {
    return this.complete(req);
  }
}

console.log('\n== 工作流 yaml 解析 ==');
const wf = parseWorkflowYaml(readFileSync(`${STORYBOARD_WORKFLOWS_DIR}/cinematic-default.yaml`, 'utf8'));
check('name=cinematic-default', wf.name === 'cinematic-default', wf.name);
check('5 阶段', wf.stages.length === 5, String(wf.stages.length));
check('顺序 read/shots/link/validate/humanize', wf.stages.map((s) => s.key).join(',') === 'read,shots,link,validate,humanize', wf.stages.map((s) => s.key).join(','));
check('humanize 绑定 skill', wf.stages.find((s) => s.key === 'humanize')?.skill === '分镜-人类化改写');
check('validate 内联', wf.stages.find((s) => s.key === 'validate')?.inline === true);
check('导演之声池 6 个', wf.voices.length === 6, String(wf.voices.length));

console.log('\n== 容错解析 ==');
const ok = safeParseStage(JSON.stringify(readFixture) + ' 尾随垃圾', DirectorsReadSchema);
check('尾随垃圾可解析', ok?.voice === '亲密极简');
check('非法 JSON 返回 null', safeParseStage('not json at all', DirectorsReadSchema) === null);
const panels = safeParseStage(JSON.stringify({ panels: PANELS }), PanelsSchema);
check('panels 解析 5 格', panels?.panels.length === 5);

console.log('\n== 五级校验（内联）==');
const vp1 = validatePanels(PANELS);
check('干净夹具 VP1 无 error', vp1.errors.length === 0, vp1.errors.join('|'));
const bad = validatePanels([{ ...PANELS[0], positive_prompt: 'epic cinematic camera shot with dolly zoom' }]);
check('反陈词/设备词命中', bad.errors.some((e) => e.includes('反陈词')) || bad.errors.some((e) => e.includes('设备词')), bad.errors.join('|'));
const vp2 = validateSequence(seqFixture);
check('干净串联 VP2 无 error', vp2.errors.length === 0 && vp2.warnings.length === 0, `${vp2.errors.length}/${vp2.warnings.length}`);
const vp2bgm = validateSequence({ ...seqFixture, sfx: '带 BGM 配乐' });
check('SFX 含 BGM 告警', vp2bgm.warnings.length === 1);

console.log('\n== 编排器端到端（mock 客户端，无 API）==');
const mem = new MemoryDb();
const ret = new RetrievalEngine(mem);
ret.setEmbeddingProvider(new HashEmbeddingProvider());
const deps: StoryboardDeps = {
  client: new MockClient() as unknown as StoryboardDeps['client'],
  ret,
  scanner: new LorebookScanner(mem),
  vms: new VariableManager(),
  mem,
  cardName: '测试卡',
  round: 1,
};
const orch = new StoryboardOrchestrator(deps);
const stagesSeen: string[] = [];
const result = await orch.run('深夜雨后铁桥，两人相拥坠落', { mode: 'batch', shotCount: 5 }, (label) => stagesSeen.push(label));
check('召回→四阶段→完成 阶段推进', ['召回', '导演读本', '逐镜分镜', '串联序列', '五级校验', '人类化改写', '完成'].every((s) => stagesSeen.includes(s)), stagesSeen.join('→'));
check('导演读本产出', result.directorsRead?.voice === '亲密极简', result.directorsRead?.voice ?? 'null');
check('逐镜 5 格', result.panels.length === 5, String(result.panels.length));
check('串联产出', result.sequence?.master_prompt?.length > 0);
check('人类化产出', result.humanized?.summary?.length > 0);
check('校验含 VP0/VP1/VP2', result.validation.map((v) => v.stage).join(',').includes('VP0') && result.validation.map((v) => v.stage).join(',').includes('VP1') && result.validation.map((v) => v.stage).join(',').includes('VP2'), result.validation.map((v) => v.stage).join(','));
check('整体 PASS', result.passed === true, `errors=${result.errors.length}`);
check('模型调用 4 次且顺序正确', (deps.client as unknown as MockClient).calls.join(',') === 'storyboard_read,storyboard_shots,storyboard_link,storyboard_humanize', (deps.client as unknown as MockClient).calls.join(','));
const persisted = mem.db.prepare("SELECT entity_type, entity_id, length(state_json) len FROM memory_state WHERE entity_type='storyboard'").get() as { entity_type: string; entity_id: string; len: number } | undefined;
check('落库 memory_state(storyboard)', persisted?.entity_id === '测试卡' && (persisted.len ?? 0) > 500, JSON.stringify(persisted));

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
