import { useEffect, useRef, useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface PluginInfo {
  id: string;
  kind?: 'st' | 'dsh';
  enabled: boolean;
}

/** 已加载的 widget 脚本标记（防重复注入） */
const injected = new Set<string>();

/**
 * DSH 插件可视化加载器（通用机制，不写死任何插件）：
 * 轮询 /api/plugins 发现「启用的 DSH 插件」→ 注入其约定入口 `<插件id>/widget.js`。
 * widget.js 是自挂载 DOM 的原生 JS（DSH tapIndex 同款），走同源相对路径取数据，
 * dev 由 vite 代理转发、生产由后端直接伺服，两端同源天然通。
 * 未提供 widget.js 的 DSH 插件静默跳过（404 即忽略）。
 */
export function DshWidgetLoader() {
  const [ready, setReady] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await fetch(`${API}/api/plugins`).then((r) => r.json()) as { plugins?: PluginInfo[] };
        for (const p of d.plugins ?? []) {
          if (p.kind !== 'dsh' || !p.enabled || injected.has(p.id)) continue;
          // 探测约定入口：/​<id>/widget.js（whale-widget 等 UI 插件的 DSH 惯例）
          try {
            const probe = await fetch(`/${p.id}/widget.js`, { method: 'HEAD' });
            if (!probe.ok) { injected.add(p.id); continue; }  // 无 UI 的纯服务插件，标记后不再探测
            const existing = document.getElementById(`dsh-widget-${p.id}`);
            if (existing) { injected.add(p.id); continue; }
            const s = document.createElement('script');
            s.id = `dsh-widget-${p.id}`;
            s.src = `/${p.id}/widget.js`;
            s.defer = true;
            document.body.appendChild(s);
            injected.add(p.id);
            console.log(`[DshWidget] 已加载挂件: ${p.id}`);
          } catch { /* 探测失败下轮重试 */ }
        }
      } catch { /* 后端未起时静默重试 */ }
      if (!ready) setReady(true);
      timer = setTimeout(tick, 10000);  // 常驻轮询：安装新插件后 ≤10s 自动出现
    };
    void tick();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
