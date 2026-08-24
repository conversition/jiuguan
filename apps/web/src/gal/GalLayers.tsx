/**
 * GLA 立绘/背景/CG 图层渲染（无交互，纯展示）
 * 槽位 L1..L4 → 左右分布；action → CSS 动画 class；leave → 列表移除（由播放器保证）
 */
import React from 'react';
import type { GalVisual } from './GalPlayer.ts';

/** 槽位 → 横向中心位置（百分比）与叠层次序 */
const SLOT_X: Record<string, string> = { L1: '14%', L2: '66%', L3: '50%', L4: '34%' };
const SLOT_Z: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export function GalLayers({ visual }: { visual: GalVisual }) {
  return (
    <div className="gal-layers">
      {visual.bg?.img && <img className="gal-bg" src={visual.bg.img} alt="" draggable={false} />}
      {visual.sprites.map((s) => (
        <div
          key={s.order}
          className={`gal-sprite-room${s.anim ? ` gal-anim-${s.anim}` : ''}`}
          style={{ left: SLOT_X[s.slot] ?? '50%', zIndex: SLOT_Z[s.slot] ?? 3 }}
        >
          {s.img
            ? <img className="gal-sprite" src={s.img} alt="" draggable={false} />
            : <div className="gal-sprite-missing">{s.sprite}</div>}
        </div>
      ))}
      {visual.cg?.img && (
        <div className="gal-cg"><img className="gal-cg-img" src={visual.cg.img} alt="" draggable={false} /></div>
      )}
      {visual.bgm && <div className="gal-bgm">♪ {visual.bgm.name}</div>}
    </div>
  );
}