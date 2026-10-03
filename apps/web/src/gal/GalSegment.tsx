/**
 * GLA 消息段容器：原生 VN 舞台（默认）⇄ 卡自带外部前端（备选）切换
 *  - 卡带 galExternalUrl（regex 规则的"前端界面"外链引擎页）时才显示切换；默认按**用户界面偏好**
 *  - 两条路径的 choice 都走同一 __jgfh 协议回传聊天（原生走 React sendText，外部走 postMessage helper）
 *
 * FE-05.4：`preferredMode` 由用户配置（`loadViewPrefs().sceneUi`）注入 —— 渲染决策（planMessageView）
 * 已经据此选出 external-page，**视图必须真的落到外部前端**，否则"决策对了但界面没变"。
 * 用户在段内手动切换后不再被偏好覆盖（只在偏好本身变化时同步）。
 */
import React, { useEffect, useState } from 'react';
import { GalStage } from './GalStage.tsx';
import { ExternalPage } from './ExternalPage.tsx';
import type { ViewTarget } from '../htmlCore.ts';

export function GalSegment({
  script,
  busy,
  externalUrl,
  preferredMode,
  target,
}: {
  script: string;
  busy: boolean;
  externalUrl?: string;
  /** 用户界面偏好（不按卡名强制；无外链时始终回落到原生） */
  preferredMode?: 'native' | 'external';
  target?: ViewTarget;
}) {
  const [mode, setMode] = useState<'native' | 'external'>(preferredMode ?? 'native');
  const [externalMounted, setExternalMounted] = useState(preferredMode === 'external');
  // 仅当**偏好本身**变化时同步（用户的段内手动切换不被覆盖）
  useEffect(() => {
    if (preferredMode) setMode(preferredMode);
    if (preferredMode === 'external') setExternalMounted(true);
  }, [preferredMode]);
  // 没有可用外链时，即使偏好外部也回落到原生（不产生空 iframe）
  const effective: 'native' | 'external' = externalUrl ? mode : 'native';
  return (
    <div className="gal-segment" data-scene-ui={effective}>
      {externalUrl && (
        <div className="gal-switch">
          <span className="gal-switch-label">界面</span>
          <button className={`gal-switch-btn${effective === 'native' ? ' on' : ''}`} onClick={() => setMode('native')}>原生引擎</button>
          <button className={`gal-switch-btn${effective === 'external' ? ' on' : ''}`} onClick={() => { setExternalMounted(true); setMode('external'); }}>卡自带前端</button>
        </div>
      )}
      <div hidden={effective !== 'native'}>
        <GalStage script={script} busy={busy} active={effective === 'native'} />
      </div>
      {externalMounted && externalUrl ? (
        <div hidden={effective !== 'external'}>
          <ExternalPage url={externalUrl} target={target} active={effective === 'external'} />
        </div>
      ) : null}
    </div>
  );
}
