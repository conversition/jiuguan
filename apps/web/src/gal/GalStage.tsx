/**
 * GLA 原生视觉小说舞台（支柱②③核心交付）
 *  - 播放：GalPlayer 指令消费；非线命令即时上屏；空格/Enter/方向/滚轮/点击 推进
 *  - 交互：choice 按钮 → 发用户消息触发 AI（busy 禁用）；双击全屏；ctrl 回退/重播/推进
 *  - 自适应：16:9 遮幅 + 侧栏宽度自适应；全屏态铺满视口
 *  - 资源：/api/assets/img?url=… 惰性下载+缓存（同源出图免 CDN CORS）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useGalPlayer } from './GalPlayer.ts';
import { GalLayers } from './GalLayers.tsx';
import { ChoiceOverlay } from './ChoiceOverlay.tsx';
import { getGalRuntime } from './rt.ts';
import './gal.css';

export function GalStage({ script, busy }: { script: string; busy: boolean }) {
  const player = useGalPlayer(script);
  const rootRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const current = player.current;
  const canAdvance = !!current && current.type !== 'choice';

  const advance = useCallback(() => { if (canAdvance) player.advance(); }, [canAdvance, player]);

  const onChoice = useCallback((opt: string) => {
    getGalRuntime().sendText(opt);
    player.advance(); // 越过 choice，落到后续 line / 场景结尾；AI 回复到来自成新场景
  }, [player]);

  // 键盘推进（排除输入框聚焦时），空格/Enter/右/下
  useEffect(() => {
    const isTypingTarget = () => {
      const a = document.activeElement;
      return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || (a as HTMLElement).isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        if (canAdvance) { e.preventDefault(); player.advance(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAdvance, player]);

  const toggleFull = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
    else { el.requestFullscreen().catch(() => {}); }
  };
  useEffect(() => {
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  return (
    <div
      className={`gal-stage${full ? ' gal-full' : ''}`}
      ref={rootRef}
      onDoubleClick={() => toggleFull()}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (!canAdvance) return;
        if (t.closest('.gal-ctrl, .gal-choices, .gal-choice')) return;
        player.advance();
      }}
      onWheel={(e) => { if (canAdvance && e.deltaY > 0) player.advance(); }}
    >
      <GalLayers visual={player.visual} />
      {current && (
        <div className="gal-overlay">
          {current.type === 'line' ? (
            <div className={`gal-dialog${current.role === 'narration' ? ' gal-narration' : current.role === 'user' ? ' gal-user' : ''}`}>
              {current.role !== 'narration' && current.speaker && <div className="gal-name">{current.speaker}</div>}
              <div className="gal-text">{current.text}</div>
            </div>
          ) : (
            <ChoiceOverlay options={current.options} onChoose={onChoice} busy={busy} />
          )}
        </div>
      )}
      {player.done && !current && <div className="gal-end">—— 本场景完 ——</div>}
      <div className="gal-ctrl">
        <button className="gal-ctrl-btn" onClick={player.back} title="上一句">⏪</button>
        <button className="gal-ctrl-btn" onClick={player.replay} title="重播本场景">↺</button>
        <button className="gal-ctrl-btn" onClick={advance} title="推进（空格）">⏭</button>
        <button className="gal-ctrl-btn" onClick={toggleFull} title={full ? '退出全屏' : '全屏'}>⛶</button>
        <span className="gal-hint">空格/点击/滚轮推进 · 双击全屏</span>
      </div>
    </div>
  );
}