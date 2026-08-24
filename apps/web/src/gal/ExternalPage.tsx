/**
 * 外部引擎页渲染（卡自带完整前端页，如 amakano3/index.html）
 * 流程：服务端 /api/assets/page 代理抓页（免浏览器跨域）→ 沙箱 srcdoc iframe（allow-scripts allow-modals，不透明源）
 *      → 注入 __jgSafeParent/存储 shim/JGF 交互 helper + 测高；页内脚本调 __jgfhChoice 即可把互动回传聊天（同一协议）
 * 备选路径：资源/内网依赖可能残缺（作者原版依赖"酒馆助手"+外网可达），此为可访问性兜底，默认仍走原生引擎。
 */
import React, { useEffect, useRef, useState } from 'react';
import { buildExternalSrcDoc } from '../htmlCore.ts';
import { buildFramePost, registerFrame } from './bridge.ts';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

export function ExternalPage({ url }: { url: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [height, setHeight] = useState(480);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    setErr('');
    fetch(`${API}/api/assets/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then((r) => r.json())
      .then((d) => { if (alive) { if (d.error) setErr(d.error); else setHtml(d.html); } })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [url]);

  // 注册进 __jgfh 桥（ExternalPage 与卡片自带 iframe 一致，交互协议统一）
  useEffect(() => {
    const win = ref.current?.contentWindow;
    return win ? registerFrame(win, buildFramePost(win)) : undefined;
  }, [html]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data && typeof e.data === 'object'
        && (e.data.__jgfh_h === 'height' || e.data.__jgfh_h === 'size')) {
        const h = Number(e.data.h);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(h + 8, 100), 1400));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  if (err) return <div className="gal-ext-state gal-ext-error">外部前端加载失败：{err}<p className="gal-ext-hint">可切换回原生界面。</p></div>;
  if (!html) return <div className="gal-ext-state">正在加载卡自带外部前端…</div>;
  return <iframe ref={ref} className="gal-ext-frame" title="外部前端" sandbox="allow-scripts allow-modals" srcDoc={buildExternalSrcDoc(html)} style={{ height }} />;
}