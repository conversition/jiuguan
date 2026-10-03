/**
 * 外部引擎页渲染（卡自带完整前端页，如 external-page/index.html）
 * 流程：服务端 /api/assets/page 代理抓页（免浏览器跨域）→ 沙箱 srcdoc iframe（allow-scripts allow-modals，不透明源）
 *      → 注入 __jgSafeParent/存储 shim/JGF 交互 helper + 测高；页内脚本调 __jgfhChoice 即可把互动回传聊天（同一协议）
 * 备选路径：资源/内网依赖可能残缺（作者原版依赖"酒馆助手"+外网可达），此为可访问性兜底，默认仍走原生引擎。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '../authClient.ts';
import { buildExternalSrcDoc, type ViewTarget } from '../htmlCore.ts';
import { buildFramePost, createFrameToken, isJgFrameMessage, registerFrame } from './bridge.ts';
import { FrameViewport } from '../components/FrameViewport.tsx';
import { createInitialFrameSize, mergeFrameSize, type FrameSizeState } from '../frameSize.ts';
import { prepareAssetCapabilities, type PreparedAssetCapabilities } from '../assetCapabilities.ts';
import { resolveRelativeRefs } from '../compat/resourceLoader.ts';
import { WEB_CLIENT_PROFILE } from '../clientProfile.ts';

export function ExternalPage({ url, target, active = true }: { url: string; target?: ViewTarget; active?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => createFrameToken(), [url]);
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [size, setSize] = useState<FrameSizeState>(createInitialFrameSize);
  const [assets, setAssets] = useState<PreparedAssetCapabilities | null>(null);
  useEffect(() => setSize(createInitialFrameSize()), [token]);

  useEffect(() => {
    if (!WEB_CLIENT_PROFILE.scriptedCards) return;
    let alive = true;
    setHtml(null);
    setErr('');
    authFetch('/api/assets/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!alive) return;
        if (d.error) { setErr(d.error); return; }
        const value = String(d.html ?? '');
        const prepared = await prepareAssetCapabilities(resolveRelativeRefs(value, url).html);
        if (alive) { setAssets(prepared); setHtml(value); }
      })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [url]);

  // 注册进 __jgfh 桥（ExternalPage 与卡片自带 iframe 一致，交互协议统一）
  useEffect(() => {
    if (!active) return;
    const win = ref.current?.contentWindow;
    return win ? registerFrame(win, buildFramePost(win, '*', token), token) : undefined;
  }, [active, html, token]);

  const postVisibility = () => {
    const win = ref.current?.contentWindow;
    if (!win) return;
    buildFramePost(win, '*', token)({
      __jgfh: 'host',
      op: 'visibility',
      value: { visible: active },
      target,
    });
  };
  useEffect(postVisibility, [active, html, token, target?.sessionId, target?.sessionRunId, target?.messageKey]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !isJgFrameMessage(e.data, token)) return;
      const d = e.data as {
        __jgfh_h?: string;
        w?: unknown;
        h?: unknown;
        contentHeight?: unknown;
        viewportHeight?: unknown;
      };
      if (d.__jgfh_h === 'height' || d.__jgfh_h === 'size') {
        setSize((prev) => mergeFrameSize(prev, d));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [token]);

  if (!WEB_CLIENT_PROFILE.scriptedCards) {
    return <div className="gal-ext-state gal-ext-error">当前客户端禁止内嵌外部脚本页面。</div>;
  }
  if (err) return <div className="gal-ext-state gal-ext-error">外部前端加载失败：{err}<p className="gal-ext-hint">可切换回原生界面。</p></div>;
  if (!html || !assets) return <div className="gal-ext-state">正在加载卡自带外部前端…</div>;
  return (
    <FrameViewport title='卡自带外部前端' reportedWidth={size.width} reportedHeight={size.height}>
      {(style) => (
        <iframe
          ref={ref}
          className='gal-ext-frame'
          title='外部前端'
          sandbox='allow-scripts allow-modals'
          srcDoc={buildExternalSrcDoc(html, token, {
            pageUrl: url,
            target,
            resources: assets.mode === 'secured'
              ? { assetUrls: assets.urls, failClosed: true, secureContentSource: assets.secureContentSource }
              : {},
          })}
          style={style}
          onLoad={postVisibility}
        />
      )}
    </FrameViewport>
  );
}
