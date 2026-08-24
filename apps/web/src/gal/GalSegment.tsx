/**
 * GLA 消息段容器：原生 VN 舞台（默认）⇄ 卡自带外部前端（备选）切换
 *  - 卡带 galExternalUrl（regex 规则的"前端界面"外链引擎页）时才显示切换；默认原生
 *  - 两条路径的 choice 都走同一 __jgfh 协议回传聊天（原生走 React sendText，外部走 postMessage helper）
 */
import React, { useState } from 'react';
import { GalStage } from './GalStage.tsx';
import { ExternalPage } from './ExternalPage.tsx';

export function GalSegment({
  script,
  busy,
  externalUrl,
}: {
  script: string;
  busy: boolean;
  externalUrl?: string;
}) {
  const [mode, setMode] = useState<'native' | 'external'>('native');
  return (
    <div className="gal-segment">
      {externalUrl && (
        <div className="gal-switch">
          <span className="gal-switch-label">界面</span>
          <button className={`gal-switch-btn${mode === 'native' ? ' on' : ''}`} onClick={() => setMode('native')}>原生引擎</button>
          <button className={`gal-switch-btn${mode === 'external' ? ' on' : ''}`} onClick={() => setMode('external')}>卡自带前端</button>
        </div>
      )}
      {mode === 'native'
        ? <GalStage script={script} busy={busy} />
        : <ExternalPage url={externalUrl ?? ''} />}
    </div>
  );
}