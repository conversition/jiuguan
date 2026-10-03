import { useEffect, useState } from 'react';
import { generationIsActive, subscribeGenerationActivity } from '../generationActivity.ts';
import { WEB_CLIENT_PROFILE } from '../clientProfile.ts';
import { registerServiceWorker } from './register.ts';
import { canActivateUpdate } from './updatePolicy.ts';

export function PwaUpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [generationActive, setGenerationActive] = useState(() => generationIsActive());
  const [activating, setActivating] = useState(false);

  useEffect(() => subscribeGenerationActivity(setGenerationActive), []);

  useEffect(() => {
    if (WEB_CLIENT_PROFILE.kind === 'android-bundled') return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    let installing: ServiceWorker | null = null;

    const inspect = (): void => {
      if (!disposed && registration?.waiting) setWaiting(registration.waiting);
    };
    const onInstallingState = (): void => {
      if (installing?.state === 'installed') inspect();
    };
    const onUpdateFound = (): void => {
      installing?.removeEventListener('statechange', onInstallingState);
      installing = registration?.installing ?? null;
      installing?.addEventListener('statechange', onInstallingState);
    };

    const start = async (): Promise<void> => {
      registration = await registerServiceWorker(WEB_CLIENT_PROFILE.kind);
      if (!registration || disposed) return;
      inspect();
      registration.addEventListener('updatefound', onUpdateFound);
      onUpdateFound();
    };
    if (document.readyState === 'complete') void start();
    else window.addEventListener('load', start, { once: true });

    return () => {
      disposed = true;
      window.removeEventListener('load', start);
      registration?.removeEventListener('updatefound', onUpdateFound);
      installing?.removeEventListener('statechange', onInstallingState);
    };
  }, []);

  if (!waiting) return null;
  const activate = (): void => {
    if (!canActivateUpdate({ waiting: true, generationActive, userConfirmed: true })) return;
    setActivating(true);
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    waiting.postMessage({ type: 'JG_ACTIVATE_UPDATE' });
  };

  return (
    <aside className="pwa-update-prompt" role="status" aria-live="polite">
      <div>
        <strong>新版本已就绪</strong>
        <span>{generationActive ? '当前正在生成，完成后才能安全刷新。' : '确认后切换版本并刷新当前页面。'}</span>
      </div>
      <button type="button" onClick={activate} disabled={generationActive || activating}>
        {activating ? '正在更新…' : generationActive ? '生成中' : '更新并刷新'}
      </button>
    </aside>
  );
}
