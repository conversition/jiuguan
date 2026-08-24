/**
 * GLA 舞台占位（Phase 5 由 GalStage 替换）
 * 用途：显示管线已识别 <gal_inface> 场景段，但原生渲染引擎尚未装载时，给用户一个温和的"游戏界面已就绪"标记，
 * 避免把 DSL 原文当 markdown 气泡展示。
 */
export function GalPlaceholder({ index }: { index: number }) {
  return (
    <div className="gal-msg">
      <span className="gal-ph-icon" aria-hidden="true">🎮</span>
      <div className="gal-ph-body">
        <div className="gal-ph-title">角色卡游戏界面已就绪</div>
        <div className="gal-ph-sub">场景 #{index} · 原生 Galgame 引擎渲染中…</div>
      </div>
    </div>
  );
}