/**
 * GLA 立绘/背景/CG 图层渲染（无交互，纯展示）
 * 槽位 L1..L4 → 左右分布；action → CSS 动画 class；leave → 列表移除（由播放器保证）
 */
import React, { useEffect, useState } from 'react';
import type { GalVisual } from './GalPlayer.ts';
import { resolveNamedAsset } from '../assetCapabilities.ts';

/** 槽位 → 横向中心位置（百分比）与叠层次序 */
const SLOT_X: Record<string, string> = { L1: '14%', L2: '66%', L3: '50%', L4: '34%' };
const SLOT_Z: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

function GalAssetImage({
  kind,
  name,
  className,
}: {
  kind: 'bg' | 'sprite' | 'cg';
  name: string;
  className: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    void resolveNamedAsset(kind, name).then((result) => {
      if (alive && result.status === 'ok') setUrl(result.url);
    });
    return () => { alive = false; };
  }, [kind, name]);
  return url ? <img className={className} src={url} alt="" draggable={false} /> : null;
}

export function GalLayers({ visual }: { visual: GalVisual }) {
  return (
    <div className="gal-layers">
      {visual.bg && <GalAssetImage kind="bg" name={visual.bg.name} className="gal-bg" />}
      {visual.sprites.map((s) => (
        <div
          key={s.order}
          className={`gal-sprite-room${s.anim ? ` gal-anim-${s.anim}` : ''}`}
          style={{ left: SLOT_X[s.slot] ?? '50%', zIndex: SLOT_Z[s.slot] ?? 3 }}
        >
          <GalAssetImage kind="sprite" name={s.sprite} className="gal-sprite" />
        </div>
      ))}
      {visual.cg && (
        <div className="gal-cg"><GalAssetImage kind="cg" name={visual.cg.name} className="gal-cg-img" /></div>
      )}
      {visual.bgm && <div className="gal-bgm">♪ {visual.bgm.name}</div>}
    </div>
  );
}
