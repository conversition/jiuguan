/**
 * GLA 舞台播放器（纯逻辑 hook，无 UI）
 * 播放模型：指令序列顺序消费。
 *  - 非 line/choice 指令（bg/bgm/show/alter/action/cg/hide_cg/leave）即时折叠进 visual（纯函数 at 派生，可一步回退）
 *  - line 指令 → 显示对白；用户 advance → 跳到下一条 line/choice（其间非线指令自动应用）
 *  - choice 指令 → 置当前；选完 onChoose 后 advance 越过
 *  - 到底 → done
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseGalInfaceScene } from '../../../../packages/core/src/gal.ts';
import type { GalInstruction } from '../../../../packages/core/src/gal.ts';
import { craftAssetUrl } from '../../../../packages/assets/src/resolve.ts';

export interface GalLayerLite { name: string; img: string | null }
export interface GalSpriteLayer { char: string; sprite: string; slot: string; img: string | null; anim: string | null; order: number }
export interface GalVisual {
  bg: GalLayerLite | null;
  bgm: GalLayerLite | null;
  cg: GalLayerLite | null;
  sprites: GalSpriteLayer[];
}

export type GalCurrent =
  | { type: 'line'; speaker: string; text: string; role: 'char' | 'narration' | 'user' }
  | { type: 'choice'; options: string[] }
  | null;

/** kind/name → 服务端同源出图 URL（惰性下载+缓存，浏览器免 CDN CORS）；无规律构造的资源返回 null */
function imgSrc(kind: 'bg' | 'sprite' | 'cg', name: string): string | null {
  const url = craftAssetUrl(kind, name);
  return url ? `/api/assets/img?url=${encodeURIComponent(url)}` : null;
}

let orderSeed = 0;
const nextOrder = (): number => ++orderSeed;

function applyNonLine(v: GalVisual, ins: GalInstruction): GalVisual {
  switch (ins.kind) {
    case 'bg': return { ...v, bg: { name: ins.name, img: imgSrc('bg', ins.name) } };
    // bgm 音频暂无可推断 URL（清单无音频）；展示层给「♪ 曲名」占位，不崩
    case 'bgm': return { ...v, bgm: { name: ins.name, img: null } };
    case 'cg': return { ...v, cg: { name: ins.name, img: imgSrc('cg', ins.name) } };
    case 'hide_cg': return { ...v, cg: null };
    case 'show': {
      const img = imgSrc('sprite', ins.sprite);
      return {
        ...v,
        sprites: [
          ...v.sprites.filter((s) => s.char !== ins.char),
          { char: ins.char, sprite: ins.sprite, slot: ins.slot, img, anim: null, order: nextOrder() },
        ],
      };
    }
    case 'alter': {
      return { ...v, sprites: v.sprites.map((s) => (s.char === ins.char ? { ...s, sprite: ins.sprite, img: imgSrc('sprite', ins.sprite) } : s)) };
    }
    case 'action': {
      return { ...v, sprites: v.sprites.map((s) => (s.char === ins.char ? { ...s, anim: ins.anim } : s)) };
    }
    case 'leave': return { ...v, sprites: v.sprites.filter((s) => s.char !== ins.char) };
    default: return v;
  }
}

/** 从 `from` 之后找下一条 line/choice（其间非线指令被跳过【应用】）；返回其下标或 len */
function landOn(instructions: GalInstruction[], from: number): number {
  let n = from + 1;
  while (n < instructions.length && instructions[n].kind !== 'line' && instructions[n].kind !== 'choice') n++;
  return n;
}

export interface GalPlayerResult {
  current: GalCurrent;
  visual: GalVisual;
  done: boolean;
  at: number;
  advance: () => void;
  back: () => void;
  replay: () => void;
}

export function useGalPlayer(script: string): GalPlayerResult {
  const instructions = useMemo(() => parseGalInfaceScene(script).instructions, [script]);
  const len = instructions.length;
  const landUp = useCallback((from: number) => landOn(instructions, from), [instructions]);
  const [at, setAt] = useState<number>(() => landUp(-1));
  const prevScript = useRef(script);
  useEffect(() => {
    if (prevScript.current !== script) {
      prevScript.current = script;
      setAt(landUp(-1));
    }
  }, [script, landUp]);

  const advance = useCallback(() => { setAt((prev) => landUp(prev)); }, [landUp]);
  const back = useCallback(() => {
    setAt((prev) => {
      if (prev <= 0) return prev;
      let n = prev - 1;
      while (n > 0 && instructions[n].kind !== 'line' && instructions[n].kind !== 'choice') n--;
      return n;
    });
  }, [instructions]);
  const replay = useCallback(() => setAt(landUp(-1)), [landUp]);

  const visual = useMemo(() => {
    let v: GalVisual = { bg: null, bgm: null, cg: null, sprites: [] };
    for (let i = 0; i < at; i++) {
      const ins = instructions[i];
      if (ins.kind === 'line' || ins.kind === 'choice') continue;
      v = applyNonLine(v, ins);
    }
    return v;
  }, [instructions, at]);

  const current = at < len ? (instructions[at] as GalCurrent) : null;
  const done = at >= len;
  return { current, visual, done, at, advance, back, replay };
}