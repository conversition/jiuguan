/**
 * GLA 玩家选择层：点击选项 → 作为用户消息发进聊天触发 AI（busy 时禁用）
 */
import React from 'react';

export function ChoiceOverlay({
  options,
  onChoose,
  busy,
}: {
  options: string[];
  onChoose: (o: string) => void;
  busy: boolean;
}) {
  return (
    <div className="gal-choices">
      {(options ?? []).map((o, i) => (
        <button key={i} className="gal-choice" onClick={() => onChoose(o)} disabled={busy}>{o}</button>
      ))}
    </div>
  );
}