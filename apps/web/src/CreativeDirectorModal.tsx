import React, { useEffect, useRef, useState } from 'react';
import { authFetch } from './authClient.ts';
import type { TextSelection } from './hooks/useTextSelectionDirector.ts';
import { renderDirectorGraphic } from '../../../packages/core/public/director-board-render.ts';

type Point = { x: number; y: number };
type Shot = { id: string; purpose: string; startMs: number; durationMs: number; background: string;
  composition: string; visible: string; camera: string; gaze: string; cutReason: string;
  geometry: { kind: 'rect' | 'ellipse' | 'line' | 'door' | 'lamp' | 'cup' | 'letter' | 'staff'; label: string; from: Point; to: Point; tone?: 'neutral' | 'warm' | 'light' | 'shadow'; motion?: { dx: number; dy: number; rotate: number } }[];
  figures: { id: string; label: string; from: Point; to: Point; gaze: Point; posture?: 'standing' | 'sitting'; gesture?: 'reach' | 'guard'; handMotion?: { from: Point; to: Point } }[] };
type Sample = { axis: string; sourceRef: string; durationMs: number; geometry: Shot['geometry']; figures: Shot['figures'] };
type Plan = { treatments: { id: string; intent: string; comparisonSamples: Sample[] }[]; selectedTreatmentId: string; selectionReason: string;
  protectedBeatRefs: string[]; differences: { axis: string; sourceRef: string; a: string; b: string; expectedDifference: string }[];
  space: string[]; actionUnits: { id: string; goal: string; start: string; movement: string; end: string; performance: string }[];
  shots: Shot[]; audio: { kind: 'dialogue' | 'ambience' | 'action' | 'music' | 'silence'; startMs: number; durationMs: number; description: string }[];
  audienceKnowledge: string[]; transitions: string[]; visualPerformanceRules: string[] };
type Board = { schemaVersion: 'director-visual-board-v1'; planId: string; planDigest: string; revision: number;
  sourceSnapshotRef: string; adaptationBranchId: string; shots: Shot[] };
type Artifact = { id: string; kind: string; digest: string; state: string; payload: unknown };
type Creative = { session: { id: string; revision: number; activeRevision: number; status: string; adaptationBranchId: string };
  continuityStatus: 'current' | 'needs-review'; continuityContexts: { parentSessionId: string; parentRevision: number; accepted: { intent: string } }[];
  version: { source: { sourceSnapshotRef: string; firstRound: number; lastRound: number; messages: { ref: string; content: string }[] };
    continuity?: { parentSessionId: string; parentRevision: number; accepted: { intent: string } };
    material: { boundary: string; boundaryReason: string; assertions: { statement: string; epistemicStatus: string; evidenceRefs: string[] }[];
      protectedRefs: string[]; unknowns: string[] } }; artifacts: Artifact[] };
const key = () => `web-${crypto.randomUUID()}`;

function SceneGraphic({ shot, progress, blind = false }: { shot: Pick<Shot, 'geometry' | 'figures'>; progress: number; blind?: boolean }) {
  return <div role="img" aria-label={blind ? '候选片段画面' : '空间、人物位置和运动方向'}
    dangerouslySetInnerHTML={{ __html: renderDirectorGraphic(shot, progress, blind) }} />;
}

type BlindBoard = { schemaVersion: 'director-blind-board-v1'; boardId: string; boardDigest: string; revision: number; activeRevision: number;
  shots: { id: string; startMs: number; durationMs: number;
    geometry: { kind: 'rect' | 'ellipse' | 'line' | 'door' | 'lamp' | 'cup' | 'letter' | 'staff'; from: Point; to: Point; tone?: 'neutral' | 'warm' | 'light' | 'shadow'; motion?: { dx: number; dy: number; rotate: number } }[];
    figures: { from: Point; to: Point; gaze: Point; posture?: 'standing' | 'sitting'; gesture?: 'reach' | 'guard'; handMotion?: { from: Point; to: Point } }[] }[] };
function BoardReview({ collection, creativeId, boardId, onClose, onDone }: {
  collection: string; creativeId: string; boardId: string; onClose(): void; onDone(value: Creative): void;
}) {
  const [board, setBoard] = useState<BlindBoard | null>(null), [comparison, setComparison] = useState<Creative | null>(null);
  const [observer, setObserver] = useState(''), [sourceExposure, setSourceExposure] = useState<'none' | 'seen' | 'unknown'>('unknown');
  const [intentExposure, setIntentExposure] = useState<'none' | 'seen' | 'unknown'>('unknown');
  const [blindId, setBlindId] = useState(''), [note, setNote] = useState(''), [error, setError] = useState('');
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const item = `${collection}/${encodeURIComponent(creativeId)}`;
  async function loadBoard(): Promise<BlindBoard> {
    const response = await authFetch(`${item}/board/${encodeURIComponent(boardId)}`);
    if (!response.ok) throw new Error(`画板不可用（${response.status}）`);
    const value = await response.json() as BlindBoard;
    if (value.schemaVersion !== 'director-blind-board-v1' || value.boardId !== boardId || !value.shots.length) throw new Error('画板数据不匹配');
    return value;
  }
  function invalidateBoard() {
    generation.current++;
    setPlaying(false); setBusy(false); setBoard(null); setComparison(null); setBlindId(''); setTime(0);
    setError('画板版本或来源不可用，观察已停止');
  }
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    let cancelled = false;
    void loadBoard().then(value => { if (!cancelled) setBoard(value); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '画板不可用'); });
    return () => { cancelled = true; };
  }, [item, boardId]);
  useEffect(() => {
    if (!board) return;
    let cancelled = false; const epoch = generation.current;
    const timer = window.setInterval(() => {
      void loadBoard().then(latest => {
        if (cancelled || epoch !== generation.current) return;
        if (latest.boardDigest !== board.boardDigest || latest.activeRevision !== board.activeRevision) { invalidateBoard(); return; }
        setBoard(current => current && latest.revision > current.revision ? { ...current, revision: latest.revision } : current);
      }).catch(() => { if (!cancelled && epoch === generation.current) invalidateBoard(); });
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [item, boardId, board?.boardDigest, board?.activeRevision]);
  const duration = board?.shots.reduce((sum, shot) => sum + shot.durationMs, 0) ?? 0;
  const shot = board?.shots.find(value => time >= value.startMs && time < value.startMs + value.durationMs)
    ?? (time === duration ? board?.shots.at(-1) : undefined);
  useEffect(() => {
    if (!playing || !duration) return;
    let last: number | null = null, frame = 0;
    const tick = (now: number) => { if (last !== null) { const elapsed = now - last; setTime(value => {
      const next = Math.min(duration, value + elapsed); if (next >= duration) setPlaying(false); return next;
    }); } last = now; frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing, duration]);
  async function save() {
    if (!board || !observer.trim() || !note.trim()) return;
    const epoch = generation.current;
    setBusy(true); setPlaying(false); setError('');
    const observedAt = new Date().toISOString(), phase = blindId ? 'contrast' : 'blind';
    try {
      const response = await authFetch(item, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        operation: 'record-board-observation', expectedRevision: board.revision,
        operationKey: key(), boardId, observer: observer.trim(), phase, ...(blindId ? { blindReviewId: blindId } : {}),
        sourceExposure, intentExposure, timeMs: Math.round(time), observation: note.trim(), observedAt,
      }) });
      if (epoch !== generation.current) return;
      if (!response.ok) throw new Error(`观察保存失败（${response.status}），请重新打开当前画板`);
      const result = await response.json() as Creative;
      if (epoch !== generation.current) return;
      const saved = result.artifacts.find(artifact => { const value = artifact.payload as { schemaVersion?: string; phase?: string;
        boardId?: string; observer?: string; observedAt?: string };
        return artifact.kind === 'review' && value.schemaVersion === 'director-board-observation-v1' && value.phase === phase
          && value.boardId === boardId && value.observer === observer.trim() && value.observedAt === observedAt; });
      if (!saved) throw new Error('观察记录未读回');
      if (phase === 'blind') { setBlindId(saved.id); setComparison(result); setBoard(current => current
        ? { ...current, revision: Math.max(current.revision, result.session.revision) } : current); setNote(''); }
      else onDone(result);
    } catch (cause) { if (epoch === generation.current) setError(cause instanceof Error ? cause.message : '观察保存失败'); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  async function play() {
    if (playing) { setPlaying(false); return; }
    if (!board) return;
    const epoch = generation.current;
    setBusy(true);
    try {
      const latest = await loadBoard();
      if (epoch !== generation.current) return;
      if (latest.boardDigest !== board.boardDigest || latest.activeRevision !== board.activeRevision) throw new Error('board-stale');
      setBoard(current => current ? { ...current, revision: Math.max(current.revision, latest.revision) } : current);
      if (time >= duration) setTime(0); setPlaying(true);
    } catch { if (epoch === generation.current) invalidateBoard(); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  const plan = comparison?.artifacts.find(item => item.kind === 'plan' && item.state === 'current')?.payload as Plan | undefined;
  return <div className="director-modal" role="dialog" aria-modal="true" aria-label="画板观察"><div className="director-panel creative-director-panel">
    <div className="director-head"><h2>{blindId ? '对照材料与意图' : '先观察画板'}</h2><button onClick={onClose} disabled={busy}>返回</button></div>
    <p>身份、事前接触和观看均由观察者自报；独立性与盲法尚未核验。无音频，时长为估算。</p>
    {error && <p className="director-error" role="alert">{error}</p>}
    <label>观察者署名 <input value={observer} disabled={!!blindId || busy} onChange={e => setObserver(e.target.value)} /></label>
    <label>此前是否看过来源 <select value={sourceExposure} disabled={!!blindId || busy} onChange={e => setSourceExposure(e.target.value as typeof sourceExposure)}>
      <option value="unknown">不确定</option><option value="none">没有</option><option value="seen">看过</option></select></label>
    <label>此前是否看过导演意图 <select value={intentExposure} disabled={!!blindId || busy} onChange={e => setIntentExposure(e.target.value as typeof intentExposure)}>
      <option value="unknown">不确定</option><option value="none">没有</option><option value="seen">看过</option></select></label>
    {shot && <><SceneGraphic shot={{ geometry: shot.geometry.map(g => ({ ...g, label: '' })),
      figures: shot.figures.map((figure, i) => ({ ...figure, id: `figure-${i}`, label: '' })) }}
      progress={Math.max(0, Math.min(1, (time - shot.startMs) / shot.durationMs))} blind />
      <div className="director-bar"><button disabled={busy} onClick={() => void play()}>{playing ? '暂停' : '播放'}</button>
        <input aria-label="画板观察位置" type="range" min={0} max={duration} value={time} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }} />
        <span>{(time / 1000).toFixed(1)} / {(duration / 1000).toFixed(1)} 秒</span></div></>}
    {comparison && <section><h3>来源与意图</h3>{comparison.version.source.messages.map(message => <p key={message.ref}>{message.ref}：{message.content}</p>)}
      <p>选择理由：{plan?.selectionReason}</p><p>意图：{plan?.treatments.find(t => t.id === plan.selectedTreatmentId)?.intent}</p></section>}
    <label>{blindId ? '对照后的具体观察' : '不看材料时观察到什么'} <textarea value={note} onChange={e => setNote(e.target.value)} /></label>
    <button disabled={busy || !board || !observer.trim() || !note.trim()} onClick={() => void save()}>{blindId ? '保存对照观察' : '保存初看并对照'}</button>
  </div></div>;
}

function BlindComparison({ plan, busy, error, onClose, onRecorded, onSubmit }: { plan: Plan; busy: boolean; error: string; onClose(): void; onRecorded(): void;
  onSubmit(observer: string, order: [string, string], observations: { axis: string; observation: string }[]): Promise<boolean> }) {
  const [order] = useState<[number, number]>(() => crypto.getRandomValues(new Uint8Array(1))[0]! % 2 ? [1, 0] : [0, 1]);
  const axes = plan.differences.filter(d => plan.treatments.every(t => Array.isArray(t.comparisonSamples)
    && t.comparisonSamples.some(s => s.axis === d.axis && s.sourceRef === d.sourceRef))).slice(0, 2);
  const [axis, setAxis] = useState(0), [slot, setSlot] = useState(0), [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [observer, setObserver] = useState(''), [notes, setNotes] = useState<Record<string, string>>({});
  const samples = plan.treatments[order[slot]!]!.comparisonSamples;
  const sample = Array.isArray(samples) ? samples.find(item => item.axis === axes[axis]?.axis && item.sourceRef === axes[axis]?.sourceRef) : undefined;
  useEffect(() => {
    if (!playing || !sample) return;
    let last: number | null = null, frame = 0;
    const tick = (now: number) => { if (last !== null) { const elapsed = now - last; setTime(value => {
      const next = Math.min(sample.durationMs, value + elapsed); if (next >= sample.durationMs) setPlaying(false); return next;
    }); } last = now; frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing, sample]);
  if (!sample || axes.length !== 2) return <div className="director-modal"><div className="director-panel creative-director-panel"><p>缺少可比较片段</p><button onClick={onClose}>返回</button></div></div>;
  return <div className="director-modal" role="dialog" aria-modal="true" aria-label="候选片段盲看"><div className="director-panel creative-director-panel">
    <div className="director-head"><h2>候选片段盲看</h2><button onClick={onClose} disabled={busy}>返回方案</button></div>
    <p>先比较画面，记录你观察到的区别。方案说明暂时隐藏；观察者身份和独立性由本人填写，尚未核验。</p>
    {error && <p role="alert" className="director-error">{error}</p>}
    <div className="director-bar">{axes.map((item, index) => <button key={item.axis} onClick={() => { setPlaying(false); setTime(0); setAxis(index); }}>比较 {index + 1}</button>)}
      {[0, 1].map(index => <button key={index} onClick={() => { setPlaying(false); setTime(0); setSlot(index); }}>片段 {index + 1}</button>)}</div>
    <p>比较 {axis + 1} · 片段 {slot + 1}</p><SceneGraphic shot={sample} progress={time / sample.durationMs} blind />
    <div className="director-bar"><button onClick={() => { if (time >= sample.durationMs) setTime(0); setPlaying(!playing); }}>{playing ? '暂停' : '播放'}</button>
      <input aria-label="片段播放位置" type="range" min={0} max={sample.durationMs} value={time} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }} />
      <span>{(time / 1000).toFixed(1)} / {(sample.durationMs / 1000).toFixed(1)} 秒</span></div>
    <label>比较 {axis + 1} 观察到的区别 <textarea value={notes[axes[axis]!.axis] ?? ''}
      onChange={e => setNotes({ ...notes, [axes[axis]!.axis]: e.target.value })} /></label>
    <label>观察者署名 <input value={observer} onChange={e => setObserver(e.target.value)} /></label>
    <button disabled={busy || !observer.trim() || axes.some(item => !notes[item.axis]?.trim())} onClick={() => void onSubmit(observer,
      [plan.treatments[order[0]]!.id, plan.treatments[order[1]]!.id], axes.map(item => ({ axis: item.axis, observation: notes[item.axis]! }))).then(saved => { if (saved) onRecorded(); })}>保存观察</button>
  </div></div>;
}

function PlanEditor({ plan, busy, error, adviceSummary, feedbackSummary, comparing, onClose, onSave }: { plan: Plan; busy: boolean; error: string; adviceSummary?: string; feedbackSummary?: string; comparing?: boolean; onClose(): void;
  onSave(next: Plan, reason: string): Promise<boolean> }) {
  const [draft, setDraft] = useState(() => structuredClone(plan));
  const [reason, setReason] = useState('');
  const [space, setSpace] = useState(() => plan.space.join('\n'));
  const [knowledge, setKnowledge] = useState(() => plan.audienceKnowledge.join('\n'));
  const [transitions, setTransitions] = useState(() => plan.transitions.join('\n'));
  const [rules, setRules] = useState(() => plan.visualPerformanceRules.join('\n'));
  const change = (edit: (value: Plan) => void) => setDraft(previous => { const next = structuredClone(previous); edit(next); return next; });
  const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
  return <div className="director-modal" role="dialog" aria-modal="true" aria-label="编辑创作计划"><div className="director-panel creative-director-panel creative-editor">
    <div className="director-head"><h2>编辑创作计划</h2><button disabled={busy} onClick={onClose}>返回</button></div>
    <p>保存会建立新版本，当前画板和观察记录将变为历史。</p>
    {adviceSummary && <p>待采纳建议：{adviceSummary}。请将希望采纳的内容写入计划。</p>}
    {feedbackSummary && <p>依据观察：{feedbackSummary}。请修改已选方案意图或选择另一方案。</p>}
    {comparing && <p>请根据比较结果改选另一方案并复核镜头；保存表示已复核镜头适配所选方案，比较记录保留在历史版本。</p>}
    {error && <p role="alert" className="director-error">{error}</p>}
    <section><h3>意图与方案</h3><label>选定方案 <select value={draft.selectedTreatmentId}
      onChange={e => change(value => { value.selectedTreatmentId = e.target.value; })}>
      {draft.treatments.map(treatment => <option key={treatment.id} value={treatment.id}>{treatment.id}</option>)}</select></label>
      {draft.treatments.map((treatment, index) => <label key={treatment.id}>{treatment.id} 的意图
        <textarea disabled={comparing} value={treatment.intent} onChange={e => change(value => { value.treatments[index]!.intent = e.target.value; })} /></label>)}
      <label>选择理由<textarea value={draft.selectionReason} onChange={e => change(value => { value.selectionReason = e.target.value; })} /></label></section>
    <section><h3>空间与动作</h3><label>空间要素（每行一项）<textarea value={space}
      onChange={e => setSpace(e.target.value)} /></label>
      {draft.actionUnits.map((action, index) => <fieldset key={action.id}><legend>{action.id}</legend>
        {([['goal', '目标'], ['start', '起始状态'], ['movement', '动作'], ['end', '结束状态'], ['performance', '表演']] as const).map(([field, label]) =>
          <label key={field}>{label}<input value={action[field]} onChange={e => change(value => { value.actionUnits[index]![field] = e.target.value; })} /></label>)}
      </fieldset>)}</section>
    <section><h3>镜头和时长</h3>{draft.shots.map((shot, index) => <fieldset key={shot.id}><legend>{shot.id} · {(shot.startMs / 1000).toFixed(1)} 秒开始</legend>
      {([['purpose', '作用'], ['composition', '构图'], ['visible', '可见内容'], ['camera', '摄影机'], ['gaze', '视线'], ['cutReason', '切换理由'], ['background', '空间']] as const).map(([field, label]) =>
        <label key={field}>{label}<input value={shot[field]} onChange={e => change(value => { value.shots[index]![field] = e.target.value; })} /></label>)}
      <label>估算时长（毫秒）<input type="number" min={100} max={120000} value={shot.durationMs}
        onChange={e => change(value => { value.shots[index]!.durationMs = Number(e.target.value); let start = 0;
          for (const item of value.shots) { item.startMs = start; start += item.durationMs; } })} /></label>
      {shot.geometry.map((shape, shapeIndex) => <fieldset key={shapeIndex}><legend>画面形状 {shapeIndex + 1}</legend>
        <label>形状 <select value={shape.kind} onChange={e => change(value => {
          value.shots[index]!.geometry[shapeIndex]!.kind = e.target.value as Shot['geometry'][number]['kind']; })}>
          <option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="line">线条</option>
          <option value="door">门</option><option value="lamp">灯</option><option value="cup">杯</option><option value="letter">信封</option><option value="staff">棍棒</option></select></label>
        <label>名称<input value={shape.label} onChange={e => change(value => { value.shots[index]!.geometry[shapeIndex]!.label = e.target.value; })} /></label>
        <label>色调 <select value={shape.tone ?? 'neutral'} onChange={e => change(value => {
          value.shots[index]!.geometry[shapeIndex]!.tone = e.target.value as NonNullable<Shot['geometry'][number]['tone']>; })}>
          <option value="neutral">普通</option><option value="warm">暖色</option><option value="light">光亮</option><option value="shadow">阴影</option></select></label>
        {([['from', '起点'], ['to', '终点']] as const).map(([field, label]) => <span key={field}>{label}
          {(['x', 'y'] as const).map(axis => <label key={axis}>{axis}<input type="number" min={0} max={1} step={0.01}
            value={shape[field][axis]} onChange={e => change(value => { value.shots[index]!.geometry[shapeIndex]![field][axis] = Number(e.target.value); })} /></label>)}</span>)}
        <label><input type="checkbox" checked={!!shape.motion} onChange={e => { const enabled = e.target.checked; change(value => {
          const target = value.shots[index]!.geometry[shapeIndex]!;
          if (enabled) target.motion = { dx: 0, dy: 0, rotate: 0 }; else delete target.motion;
        }); }} />镜头内移动或旋转</label>
        {shape.motion && ([['dx', '水平位移', -1, 1, .01], ['dy', '垂直位移', -1, 1, .01], ['rotate', '旋转角度', -180, 180, 1]] as const).map(([field, label, min, max, step]) =>
          <label key={field}>{label}<input type="number" min={min} max={max} step={step} value={shape.motion![field]}
            onChange={e => { const number = Number(e.target.value); change(value => { value.shots[index]!.geometry[shapeIndex]!.motion![field] = number; }); }} /></label>)}
        <button disabled={shot.geometry.length <= 1} onClick={() => change(value => { value.shots[index]!.geometry.splice(shapeIndex, 1); })}>删除形状</button></fieldset>)}
      <button disabled={shot.geometry.length >= 20} onClick={() => change(value => { value.shots[index]!.geometry.push({
        kind: 'rect', label: '新形状', from: { x: 0.2, y: 0.2 }, to: { x: 0.5, y: 0.5 } }); })}>添加形状</button>
      {shot.figures.map((figure, figureIndex) => <fieldset key={figure.id}><legend>{figure.label} · 画面位置（0–1）</legend>
        <label>姿态<select value={figure.posture ?? ''} onChange={e => change(value => {
          const target = value.shots[index]!.figures[figureIndex]!;
          if (e.target.value) target.posture = e.target.value as NonNullable<typeof target.posture>; else delete target.posture;
        })}><option value="">圆点</option><option value="standing">站立</option><option value="sitting">坐姿</option></select></label>
        <label>手势<select value={figure.gesture ?? ''} onChange={e => change(value => {
          const target = value.shots[index]!.figures[figureIndex]!;
          if (e.target.value) target.gesture = e.target.value as NonNullable<typeof target.gesture>; else delete target.gesture;
          if (target.gesture !== 'reach') delete target.handMotion;
        })}><option value="">无</option><option value="reach">伸手</option><option value="guard">防御</option></select></label>
        {figure.gesture === 'reach' && <><label><input type="checkbox" checked={!!figure.handMotion} onChange={e => {
          const enabled = e.target.checked; change(value => { const target = value.shots[index]!.figures[figureIndex]!;
            if (enabled) target.handMotion = { from: { ...target.from }, to: { ...target.from } }; else delete target.handMotion;
          }); }} />手部运动</label>
          {figure.handMotion && ([['from', '手部起点'], ['to', '手部终点']] as const).map(([field, label]) => <span key={field}>{label}
            {(['x', 'y'] as const).map(axis => <label key={axis}>{axis}<input type="number" min={0} max={1} step={0.01}
              value={figure.handMotion![field][axis]} onChange={e => { const number = Number(e.target.value); change(value => {
                value.shots[index]!.figures[figureIndex]!.handMotion![field][axis] = number;
              }); }} /></label>)}</span>)}</>}
        {([['from', '起点'], ['to', '终点'], ['gaze', '视线']] as const).map(([field, label]) => <span key={field}>{label}
          {(['x', 'y'] as const).map(axis => <label key={axis}>{axis}<input type="number" min={0} max={1} step={0.01}
            value={figure[field][axis]} onChange={e => change(value => { value.shots[index]!.figures[figureIndex]![field][axis] = Number(e.target.value); })} /></label>)}</span>)}</fieldset>)}
    </fieldset>)}</section>
    <section><h3>声音与观众信息</h3>{draft.audio.map((cue, index) => <fieldset key={index}><legend>声音 {index + 1}</legend>
      <select aria-label={`声音 ${index + 1} 类型`} value={cue.kind} onChange={e => change(value => { value.audio[index]!.kind = e.target.value as typeof cue.kind; })}>
        <option value="dialogue">对白</option><option value="ambience">环境</option><option value="action">动作</option><option value="music">音乐</option><option value="silence">静默</option></select>
      <label>开始毫秒<input type="number" min={0} value={cue.startMs} onChange={e => change(value => { value.audio[index]!.startMs = Number(e.target.value); })} /></label>
      <label>持续毫秒<input type="number" min={1} value={cue.durationMs} onChange={e => change(value => { value.audio[index]!.durationMs = Number(e.target.value); })} /></label>
      <label>内容<input value={cue.description} onChange={e => change(value => { value.audio[index]!.description = e.target.value; })} /></label>
      <button onClick={() => change(value => { value.audio.splice(index, 1); })}>删除声音</button></fieldset>)}
      <button onClick={() => change(value => { value.audio.push({ kind: 'silence', startMs: 0, durationMs: 100, description: '' }); })}>添加声音</button>
      <label>观众信息（每行一项）<textarea value={knowledge} onChange={e => setKnowledge(e.target.value)} /></label>
      <label>镜头衔接（每行一项）<textarea value={transitions} onChange={e => setTransitions(e.target.value)} /></label>
      <label>视觉与表演规则（每行一项）<textarea value={rules} onChange={e => setRules(e.target.value)} /></label></section>
    <label>修改理由<input value={reason} onChange={e => setReason(e.target.value)} /></label>
    <button disabled={busy || !reason.trim()} onClick={() => void onSave({ ...draft, space: lines(space),
      audienceKnowledge: lines(knowledge), transitions: lines(transitions), visualPerformanceRules: lines(rules) }, reason.trim())
      .then(saved => { if (saved) onClose(); })}>保存新版本</button>
  </div></div>;
}

export function CreativeDirectorModal({ sessionId, selection, onClose }: {
  sessionId: string; selection: TextSelection; onClose(): void;
}) {
  const [creative, setCreative] = useState<Creative | null>(null);
  const [resumeId, setResumeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [blind, setBlind] = useState(false);
  const [editing, setEditing] = useState(false);
  const [boardReview, setBoardReview] = useState(false);
  const [adviceForEdit, setAdviceForEdit] = useState<{ id: string; summary: string } | null>(null);
  const [feedbackForEdit, setFeedbackForEdit] = useState<{ id: string; summary: string } | null>(null);
  const [comparisonForEdit, setComparisonForEdit] = useState<string | null>(null);
  const [exportReviewId, setExportReviewId] = useState('');
  const [exportComparisonId, setExportComparisonId] = useState('');
  const [historyRevision, setHistoryRevision] = useState('');
  const [historicalExports, setHistoricalExports] = useState<{ sessionId: string; revision: number; artifacts: Artifact[] } | null>(null);
  const [nextRound, setNextRound] = useState('');
  const [upstreamCandidate, setUpstreamCandidate] = useState<{ parent: Creative; acceptance: Artifact } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [question, setQuestion] = useState('');
  const [targetRef, setTargetRef] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const last = useRef<number | null>(null);
  const collection = `/api/session/${encodeURIComponent(sessionId)}/creative`;
  const planArtifact = creative?.artifacts.find(a => a.kind === 'plan' && a.state === 'current');
  const plan = planArtifact?.payload as Plan | undefined;
  const currentTargetRef = plan && plan.protectedBeatRefs.includes(targetRef) ? targetRef : plan?.protectedBeatRefs[0] ?? '';
  const previewArtifact = creative?.artifacts.find(a => a.kind === 'previz' && a.state === 'current');
  const board = previewArtifact?.payload as Board | undefined;
  const validBoard = board && planArtifact && board.schemaVersion === 'director-visual-board-v1'
    && board.planId === planArtifact.id && board.planDigest === planArtifact.digest
    && board.revision === creative?.session.activeRevision && board.sourceSnapshotRef === creative?.version.source.sourceSnapshotRef
    && board.adaptationBranchId === creative?.session.adaptationBranchId ? board : undefined;
  const duration = validBoard?.shots.reduce((total, shot) => total + shot.durationMs, 0) ?? 0;
  const shot = validBoard?.shots.find(s => time >= s.startMs && time < s.startMs + s.durationMs)
    ?? (time === duration ? validBoard?.shots.at(-1) : undefined);
  const progress = shot ? Math.max(0, Math.min(1, (time - shot.startMs) / shot.durationMs)) : 0;
  useEffect(() => {
    if (!playing || !duration) return;
    let frame = 0; last.current = null;
    const tick = (now: number) => {
      if (last.current !== null) setTime(value => {
        const next = Math.min(duration, value + now - last.current!);
        if (next >= duration) setPlaying(false);
        return next;
      });
      last.current = now; frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); last.current = null; };
  }, [playing, duration]);
  async function request(path: string, body?: unknown): Promise<Creative> {
    const response = await authFetch(path, body === undefined ? undefined : { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        && /^director-[a-z-]+$/u.test(body.error) ? body.error : '';
      throw new Error(`请求失败（${response.status}${code ? `，${code}` : ''}）`);
    }
    return await response.json() as Creative;
  }
  async function execute(work: () => Promise<Creative>, refreshOnFailure = false) {
    setBusy(true); setError(''); setPlaying(false);
    try { const next = await work();
      if (next.session.id !== creative?.session.id || next.session.activeRevision !== creative?.session.activeRevision) {
        setRevealed(false); setUpstreamCandidate(null);
      }
      setCreative(next); setResumeId(next.session.id); setTime(0); return true; }
    catch (cause) {
      if (refreshOnFailure && creative) {
        try {
          const latest = await request(`${collection}/${encodeURIComponent(creative.session.id)}`);
          if (latest.session.id !== creative.session.id || latest.session.activeRevision !== creative.session.activeRevision) {
            setRevealed(false); setEditing(false); setBlind(false); setAdviceForEdit(null); setComparisonForEdit(null); setTime(0);
          }
          setCreative(latest);
        } catch {
          setCreative(null); setRevealed(false); setEditing(false); setBlind(false); setAdviceForEdit(null); setComparisonForEdit(null); setTime(0);
        }
      }
      setError(cause instanceof Error ? cause.message : '请求失败'); return false;
    }
    finally { setBusy(false); }
  }
  async function play() {
    if (playing) { setPlaying(false); return; }
    if (!creative || !planArtifact || !previewArtifact) return;
    setBusy(true); setError('');
    let readSucceeded = false;
    try {
      const latest = await request(`${collection}/${encodeURIComponent(creative.session.id)}`);
      readSucceeded = true;
      const currentPlan = latest.artifacts.find(item => item.kind === 'plan' && item.state === 'current');
      const currentBoard = latest.artifacts.find(item => item.id === previewArtifact.id && item.state === 'current');
      setCreative(latest);
      if (latest.session.activeRevision !== creative.session.activeRevision || currentPlan?.digest !== planArtifact.digest || !currentBoard) {
        setTime(0); throw new Error('创作版本已更新，请重新生成或打开当前画板');
      }
      if (time >= duration) setTime(0);
      setPlaying(true);
    } catch (cause) { setPlaying(false); if (!readSucceeded) setCreative(null); setError(cause instanceof Error ? cause.message : '请求失败'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!playing || !creative || !planArtifact || !previewArtifact) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void request(`${collection}/${encodeURIComponent(creative.session.id)}`).then(latest => {
        if (stopped) return;
        const currentPlan = latest.artifacts.find(item => item.kind === 'plan' && item.state === 'current');
        const currentBoard = latest.artifacts.find(item => item.id === previewArtifact.id && item.state === 'current');
        if (latest.session.activeRevision !== creative.session.activeRevision || currentPlan?.digest !== planArtifact.digest || !currentBoard) {
          setPlaying(false); setCreative(latest); setTime(0); setError('创作版本已更新，播放已停止');
        }
      }).catch(() => { if (!stopped) { setPlaying(false); setCreative(null); setError('来源不可用，播放已停止'); } });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [playing, creative?.session.id, creative?.session.activeRevision, planArtifact?.digest, previewArtifact?.id]);
  const command = (operation: string, extra: Record<string, unknown> = {}) => execute(() => request(`${collection}/${encodeURIComponent(creative!.session.id)}`, {
    operation, expectedRevision: creative!.session.revision, operationKey: key(), ...extra,
  }), true);
  const reviews = creative?.artifacts.filter(item => item.kind === 'review' && item.state === 'current') ?? [];
  const needsReview = creative?.continuityStatus === 'needs-review';
  const sceneAcceptance = reviews.find(item => { const value = item.payload as { schemaVersion?: string; planId?: string; boardId?: string };
    return value.schemaVersion === 'director-scene-acceptance-v1' && value.planId === planArtifact?.id && value.boardId === previewArtifact?.id; });
  const consultations = reviews.filter(item => (item.payload as { schemaVersion?: string }).schemaVersion === 'director-consultation-v1');
  const planOrigin = reviews.find(item => { const value = item.payload as { schemaVersion?: string; planId?: string; planDigest?: string };
    return value.schemaVersion === 'director-plan-provenance-v1' && value.planId === planArtifact?.id && value.planDigest === planArtifact?.digest; });
  const boardReviews = reviews.filter(item => { const value = item.payload as { schemaVersion?: string; phase?: string; boardId?: string };
    return value.schemaVersion === 'director-board-observation-v1' && value.phase === 'contrast' && value.boardId === previewArtifact?.id; });
  const modelBlindReviews = reviews.filter(item => { const value = item.payload as { schemaVersion?: string; phase?: string; boardId?: string; observerKind?: string };
    return value.schemaVersion === 'director-board-observation-v1' && value.phase === 'blind' && value.observerKind === 'official-model' && value.boardId === previewArtifact?.id; });
  const currentExportReviewId = boardReviews.some(item => item.id === exportReviewId) ? exportReviewId : '';
  const comparisons = reviews.filter(item => { const value = item.payload as { schemaVersion?: string; planId?: string };
    return value.schemaVersion === 'director-comparison-observation-v1' && value.planId === planArtifact?.id; });
  const selections = reviews.filter(item => { const value = item.payload as { schemaVersion?: string; planId?: string };
    return value.schemaVersion === 'director-selection-decision-v1' && value.planId === planArtifact?.id; });
  const currentExportComparisonId = comparisons.some(item => item.id === exportComparisonId) ? exportComparisonId : '';
  const exportSelection = selections.find(item => (item.payload as { comparisonId?: string }).comparisonId === currentExportComparisonId);
  async function loadHistory() {
    if (!creative || !/^[1-9][0-9]*$/u.test(historyRevision)) return;
    setBusy(true); setError('');
    try {
      const revision = Number(historyRevision);
      if (!Number.isSafeInteger(revision)) throw new Error('版本号无效');
      const result = await request(`${collection}/${encodeURIComponent(creative.session.id)}?revision=${revision}`);
      setHistoricalExports({ sessionId: creative.session.id, revision, artifacts: result.artifacts.filter(item => item.kind === 'export') });
    } catch (cause) { setHistoricalExports(null); setError(cause instanceof Error ? cause.message : '读取历史失败'); }
    finally { setBusy(false); }
  }
  async function inspectUpstream() {
    const parentId = creative?.version.continuity?.parentSessionId;
    if (!parentId) return;
    setBusy(true); setError(''); setUpstreamCandidate(null);
    try {
      const parent = await request(`${collection}/${encodeURIComponent(parentId)}`);
      const plan = parent.artifacts.find(item => item.kind === 'plan' && item.state === 'current');
      const acceptance = parent.artifacts.find(item => { const value = item.payload as { schemaVersion?: string; planId?: string };
        return item.kind === 'review' && item.state === 'current' && value.schemaVersion === 'director-scene-acceptance-v1' && value.planId === plan?.id; });
      if (parent.continuityStatus !== 'current' || parent.session.status !== 'paused' || !plan || !acceptance)
        throw new Error('上游当前版本尚未采纳，请先在上游场景生成画板并采纳');
      setUpstreamCandidate({ parent, acceptance });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '上游不可用'); }
    finally { setBusy(false); }
  }
  async function downloadExport(artifact: Artifact, revision: number, historical = false) {
    if (!creative) return;
    setBusy(true); setError('');
    try {
      const result = await request(`${collection}/${encodeURIComponent(creative.session.id)}?revision=${revision}`);
      const current = result.artifacts.find(item => item.id === artifact.id && item.kind === 'export' && item.digest === artifact.digest);
      if (!current) throw new Error('导出不存在或已变化');
      if (!historical && (result.session.activeRevision !== revision || current.state !== 'current'))
        throw new Error('创作版本已更新，请从历史导出下载旧版本');
      const url = URL.createObjectURL(new Blob([JSON.stringify(current.payload, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `director-revision-${revision}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '下载失败'); }
    finally { setBusy(false); }
  }
  if (boardReview && creative && previewArtifact) return <BoardReview key={previewArtifact.id} collection={collection}
    creativeId={creative.session.id} boardId={previewArtifact.id} onClose={() => setBoardReview(false)}
    onDone={next => { setCreative(next); setBoardReview(false); }} />;
  if (editing && plan && creative) return <PlanEditor key={planArtifact!.digest} plan={plan} busy={busy} error={error}
    adviceSummary={adviceForEdit?.summary} feedbackSummary={feedbackForEdit?.summary} comparing={!!comparisonForEdit}
    onClose={() => { setEditing(false); setAdviceForEdit(null); setFeedbackForEdit(null); setComparisonForEdit(null); }}
    onSave={(next, reason) => command('revise-plan', { reason, plan: next, ...(adviceForEdit ? { adviceId: adviceForEdit.id } : {}),
      ...(feedbackForEdit ? { feedbackId: feedbackForEdit.id } : {}), ...(comparisonForEdit ? { comparisonId: comparisonForEdit, visualReviewed: true } : {}) })} />;
  if (blind && plan && creative) return <BlindComparison plan={plan} busy={busy} error={error} onClose={() => setBlind(false)}
    onRecorded={() => { setBlind(false); setRevealed(true); }}
    onSubmit={(observer, order, observations) => execute(() => request(`${collection}/${encodeURIComponent(creative.session.id)}`, {
      operation: 'record-comparison', expectedRevision: creative.session.revision, operationKey: key(), observer, order, observations,
    }), true)} />;
  return <div className="director-modal" role="dialog" aria-modal="true" aria-label="改编创作">
    <div className="director-panel creative-director-panel">
      <div className="director-head"><div><h2>改编创作</h2><p>已提交的第 {creative?.version.source.firstRound ?? selection.round}–{creative?.version.source.lastRound ?? selection.round} 轮 · 时间为估算值</p></div>
        <button className="op-btn" onClick={onClose} disabled={busy} aria-label="关闭">✕</button></div>
      <div className="director-bar">
        <button disabled={busy || selection.round < 1} onClick={() => void execute(() => request(collection, {
          requestKey: key(), firstRound: selection.round, lastRound: selection.round,
          policy: { allowL2: false, approvedL3Digests: [] },
        }))}>新建创作</button>
        <input aria-label="创作会话 ID" placeholder="创作会话 ID" value={resumeId} onChange={e => setResumeId(e.target.value)} />
        <button disabled={busy || !resumeId.trim()} onClick={() => void execute(() => request(`${collection}/${encodeURIComponent(resumeId.trim())}`))}>打开</button>
        <button disabled={busy || !creative || needsReview || !!plan || creative.session.status !== 'paused'} onClick={() => void command('review-material')}>核对材料</button>
        <button disabled={busy || !creative || needsReview || !!plan || creative.session.status !== 'paused' || creative.version.material.boundary === 'insufficient'
          || creative.version.material.boundaryReason === '材料已冻结，场景边界尚未评审。'} onClick={() => void command('generate-plan')}>生成双方案</button>
        <button disabled={busy || !plan || !revealed || !!validBoard || creative?.session.status !== 'paused'} onClick={() => void command('create-previz')}>生成画板</button>
        <button disabled={busy || !validBoard || creative?.session.status !== 'paused'} onClick={() => { setPlaying(false); setBoardReview(true); }}>观察画板</button>
        <button disabled={busy || !plan || creative?.session.status !== 'paused'} onClick={() => { setPlaying(false); setBlind(true); }}>候选片段盲看</button>
        <button disabled={busy || !plan || needsReview || creative?.session.status !== 'paused'} onClick={() => void command('observe-comparison-model')}>模型盲看双方案</button>
        <button disabled={busy || !plan || !revealed || creative?.session.status !== 'paused'} onClick={() => { setPlaying(false); setAdviceForEdit(null); setFeedbackForEdit(null); setComparisonForEdit(null); setEditing(true); }}>编辑计划</button>
        <button disabled={busy || !creative} onClick={() => void execute(() => request(`${collection}/${encodeURIComponent(creative!.session.id)}`))}>刷新</button>
      </div>
      {error && <p className="director-error" role="alert">{error}</p>}
      {creative && <p>创作版本 {creative.session.activeRevision} · {creative.session.status}</p>}
      {creative?.version.continuity && <section><h3>前场改编</h3>{creative.continuityContexts.map(item =>
        <p key={`${item.parentSessionId}-${item.parentRevision}`}>来自 {item.parentSessionId} 的版本 {item.parentRevision}；已采纳意图：{item.accepted.intent}。</p>)}
        {needsReview && <><p role="alert">上游已变更，本场产物待复核，生成和导出已停止。</p>
          <button disabled={busy} onClick={() => void inspectUpstream()}>查看上游当前采纳</button>
          {upstreamCandidate?.parent.session.id === creative.version.continuity.parentSessionId && <><p>上游当前版本 {upstreamCandidate.parent.session.activeRevision}，已选意图：{(() => {
            const p = upstreamCandidate.parent.artifacts.find(item => item.kind === 'plan' && item.state === 'current')?.payload as Plan | undefined;
            return p?.treatments.find(item => item.id === p.selectedTreatmentId)?.intent ?? '不可用'; })()}</p>
            <button disabled={busy} onClick={() => void command('refresh-continuity', { acceptanceId: upstreamCandidate.acceptance.id,
              reason: '用户复核并采用上游当前版本' })}>更新本场依赖</button></>}</>}</section>}
      {creative && <section><h3>材料核对</h3><p>{creative.version.material.boundary}：{creative.version.material.boundaryReason}</p>
        {creative.version.material.assertions.map((item, index) => <p key={index}>{item.epistemicStatus}：{item.statement}（{item.evidenceRefs.join('、')}）</p>)}
        {!!creative.version.material.protectedRefs.length && <p>保留来源：{creative.version.material.protectedRefs.join('、')}</p>}
        {creative.version.material.unknowns.map((item, index) => <p key={index}>未确定：{item}</p>)}</section>}
      {plan && <section><h3>候选处理</h3>{revealed ? <>{plan.treatments.map(t => <p key={t.id}>{t.id === plan.selectedTreatmentId ? '已选择 · ' : ''}{t.intent}</p>)}
        <p>{plan.selectionReason}</p>{plan.differences.map(d => <p key={d.axis}>{d.axis}：{d.a} / {d.b}；预期 {d.expectedDifference}</p>)}</>
        : <p>方案说明已隐藏，可先进行候选片段盲看。 <button onClick={() => setRevealed(true)}>查看方案说明</button></p>}</section>}
      {comparisons.filter(item => (item.payload as { observerKind?: string }).observerKind === 'official-model').map(item =>
        <section key={item.id}><p>模型盲看（静帧，独立性未核验）：</p>{(item.payload as { observations: { pair: number; observation: string }[] }).observations.map(result =>
          <p key={result.pair}>比较 {result.pair}：{result.observation}</p>)}</section>)}
      {revealed && comparisons.map(item => { const decision = selections.find(value => (value.payload as { comparisonId?: string }).comparisonId === item.id);
        const data = item.payload as { observer: string; order?: string[]; groups?: { pair: number; candidate: number; treatmentId: string }[];
          observations?: { axis?: string; pair?: number; observation: string }[] };
        return <section key={item.id}><p>比较记录：{data.observer} · {item.id.slice(-8)}</p>
          {data.groups?.map(group => <p key={`${group.pair}-${group.candidate}`}>比较 {group.pair} · 片段 {group.candidate}：{group.treatmentId}</p>)}
          {data.order && <p>片段 1：{data.order[0]}；片段 2：{data.order[1]}</p>}
          {data.observations?.map((observation, index) => <p key={index}>{observation.axis ?? `比较 ${observation.pair}`}：{observation.observation}</p>)}
          <button disabled={busy || creative?.session.status !== 'paused'} onClick={() => { setPlaying(false); setAdviceForEdit(null);
            setFeedbackForEdit(null); setComparisonForEdit(item.id); setEditing(true); }}>根据比较改选方案</button>
          {decision ? <p>已保留当前方案：{(decision.payload as { reason: string }).reason}</p> : <>
            <input aria-label="选案理由" placeholder="保留当前方案的理由" value={reasons[item.id] ?? ''} onChange={e => setReasons({ ...reasons, [item.id]: e.target.value })} />
            <button disabled={busy || !reasons[item.id]?.trim() || creative?.session.status !== 'paused'} onClick={() => void command('confirm-treatment',
              { comparisonId: item.id, reason: reasons[item.id]!.trim() })}>保留当前方案</button></>}</section>; })}
      {plan && revealed && <p>{planOrigin ? (() => { const origin = planOrigin.payload as { requestedModel: string; reportedModel: string | null; identity: string };
        return `导演请求模型：${origin.requestedModel}；上游报告：${origin.reportedModel ?? '未知'}；身份：${origin.identity}；实际模型版本未知。`; })()
        : '导演模型身份未知（手工或历史计划）。'}</p>}
      {plan && revealed && <section><h3>咨询顾问</h3><div className="director-bar">
        <input aria-label="顾问问题" placeholder="想解决的具体问题" value={question} onChange={e => setQuestion(e.target.value)} />
        <select aria-label="目标片段" value={currentTargetRef} onChange={e => setTargetRef(e.target.value)}>
          {plan.protectedBeatRefs.map(ref => <option key={ref} value={ref}>{ref}</option>)}</select>
        <button disabled={busy || !question.trim() || creative?.session.status !== 'paused'} onClick={() => void command('consult-plan', {
          question: question.trim(), targetRef: currentTargetRef,
        })}>咨询</button></div>
        {consultations.map(item => { const record = item.payload as { advice: { summary: string; expectedChange: string; impact: string }; model: string };
          const decision = reviews.find(review => (review.payload as { schemaVersion?: string; adviceId?: string }).schemaVersion === 'director-advice-decision-v1'
            && (review.payload as { adviceId?: string }).adviceId === item.id);
          return <div key={item.id}><p>{record.advice.summary} · 预期：{record.advice.expectedChange} · 影响：{record.advice.impact}（{record.model}）</p>
            {decision ? <p>已拒绝：{(decision.payload as { reason: string }).reason}</p> : <div className="director-bar">
              <button disabled={busy} onClick={() => { setPlaying(false); setFeedbackForEdit(null); setComparisonForEdit(null); setAdviceForEdit({ id: item.id, summary: record.advice.summary }); setEditing(true); }}>采纳并编辑</button>
              <input aria-label="拒绝理由" placeholder="整场取舍的理由" value={reasons[item.id] ?? ''}
                onChange={e => setReasons({ ...reasons, [item.id]: e.target.value })} />
              <button disabled={busy || !reasons[item.id]?.trim()} onClick={() => void command('reject-advice', {
                adviceId: item.id, reason: reasons[item.id]!.trim(),
              })}>拒绝建议</button></div>}</div>; })}
      </section>}
      {plan && revealed && reviews.filter(review => (review.payload as { schemaVersion?: string; decision?: string }).schemaVersion === 'director-advice-decision-v1'
        && (review.payload as { decision?: string }).decision === 'accepted').map(review => <p key={review.id}>已采纳顾问建议：{(review.payload as { reason: string }).reason}</p>)}
      {revealed && validBoard && <section><h3>观察与导出</h3>
        <p>官网 DeepSeek Flash 可辅助观察最多四个镜头的抽样静帧；每阶段单独调用并计费。时长为估算，无音频，独立性尚未核验。</p>
        {validBoard.shots.length > 4 && <p>当前画板超过四个镜头，模型观察无法启动。</p>}
        <button disabled={busy || needsReview || creative?.session.status !== 'paused' || validBoard.shots.length > 4}
          onClick={() => void command('observe-board-model', { boardId: previewArtifact!.id, phase: 'blind' })}>模型初看静帧</button>
        {modelBlindReviews.map(item => <div key={item.id}><p>初看：{(item.payload as { observation: string }).observation}</p>
          <button disabled={busy || needsReview || creative?.session.status !== 'paused'} onClick={() => void command('observe-board-model',
            { boardId: previewArtifact!.id, phase: 'contrast', blindReviewId: item.id })}>对照材料与意图</button></div>)}
        <div className="director-bar"><button disabled={busy || !!sceneAcceptance || needsReview || creative?.session.status !== 'paused'}
          onClick={() => void command('accept-scene', { boardId: previewArtifact!.id })}>{sceneAcceptance ? '本场已采纳' : '采纳本场改编'}</button>
          <input aria-label="后场轮次" type="number" min={(creative?.version.source.lastRound ?? 0) + 1} placeholder="后场轮次" value={nextRound} onChange={e => setNextRound(e.target.value)} />
          <button disabled={busy || !sceneAcceptance || needsReview || !creative || !/^[1-9][0-9]*$/u.test(nextRound)
            || Number(nextRound) <= creative.version.source.lastRound || !Number.isSafeInteger(Number(nextRound))}
            onClick={() => void execute(() => request(collection, { requestKey: key(), firstRound: Number(nextRound), lastRound: Number(nextRound),
              policy: { allowL2: false, approvedL3Digests: [] }, parent: { creativeId: creative!.session.id, acceptanceId: sceneAcceptance!.id } }))}>创建后场</button></div>
        {boardReviews.map(item => { const observation = item.payload as { observer: string; timeMs: number; observation: string; observerKind?: string;
          observations?: { timeMs: number; description: string }[] };
          return <div key={item.id}><p>{observation.observer} · {(observation.timeMs / 1000).toFixed(1)} 秒：{observation.observation}（独立性未核验）</p>
            {observation.observerKind === 'official-model' && <p>初看未提供材料与意图；本次对照已提供材料与意图。</p>}
            {observation.observations?.map((frame, index) => <p key={`${frame.timeMs}-${index}`}>{(frame.timeMs / 1000).toFixed(1)} 秒：{frame.description}</p>)}
            <button disabled={busy || creative?.session.status !== 'paused'} onClick={() => { setAdviceForEdit(null); setComparisonForEdit(null); setFeedbackForEdit({ id: item.id, summary: observation.observation }); setEditing(true); }}>根据观察修订意图</button></div>; })}
        <label>导出所含观察 <select value={currentExportReviewId} onChange={e => setExportReviewId(e.target.value)}>
          <option value="">不包含观察</option>{boardReviews.map(item => <option key={item.id} value={item.id}>{(item.payload as { observer: string }).observer} · {item.id.slice(-8)}</option>)}</select></label>
        <label>导出所含方案比较 <select value={currentExportComparisonId} onChange={e => setExportComparisonId(e.target.value)}>
          <option value="">不包含比较</option>{comparisons.map(item => <option key={item.id} value={item.id}>{(item.payload as { observer: string }).observer} · {item.id.slice(-8)}</option>)}</select></label>
        <button disabled={busy || creative?.session.status !== 'paused'} onClick={() => void command('create-export', {
          boardId: previewArtifact!.id, ...(currentExportReviewId ? { reviewId: currentExportReviewId } : {}),
          ...(currentExportComparisonId ? { comparisonId: currentExportComparisonId } : {}),
          ...(exportSelection ? { selectionId: exportSelection.id } : {}),
        })}>生成同版草稿</button></section>}
      {creative && <section><h3>导出记录</h3><p>JSON 包含人读分镜、计划、画板和依赖清单；未核验独立观察时为草稿。</p>
        {creative.artifacts.filter(item => item.kind === 'export' && item.state === 'current').map(item => <button key={item.id}
          disabled={busy} onClick={() => void downloadExport(item, creative.session.activeRevision)}>下载当前草稿 {item.id.slice(-8)}</button>)}
        <div className="director-bar"><input aria-label="历史版本号" placeholder="历史版本号" value={historyRevision} onChange={e => setHistoryRevision(e.target.value)} />
          <button disabled={busy || !/^[1-9][0-9]*$/u.test(historyRevision)} onClick={() => void loadHistory()}>查找历史导出</button></div>
        {historicalExports?.sessionId === creative.session.id && <div>{historicalExports.artifacts.length ? historicalExports.artifacts.map(item =>
          <button key={item.id} disabled={busy} onClick={() => void downloadExport(item, historicalExports.revision, true)}>下载版本 {historicalExports.revision} · {item.id.slice(-8)}</button>) : <p>该版本没有导出。</p>}</div>}</section>}
      {revealed && validBoard && shot && <section aria-label="预演画板"><h3>画板预演 · {shot.id}</h3>
        <SceneGraphic shot={shot} progress={progress} />
        <div className="director-bar"><button disabled={busy} onClick={() => void play()}>{playing ? '暂停' : '播放'}</button>
          <input aria-label="播放位置" type="range" min={0} max={duration} value={time} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }} />
          <span>{(time / 1000).toFixed(1)} / {(duration / 1000).toFixed(1)} 秒</span>
          <select aria-label="定位镜头" value={shot.id} onChange={e => { setPlaying(false); setTime(validBoard.shots.find(s => s.id === e.target.value)!.startMs); }}>
            {validBoard.shots.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}</select></div>
        <p>画面与运动为粗预演；声音仅为时机标注。</p></section>}
    </div>
  </div>;
}
