import { useEffect, useMemo, useState } from 'react';
import { WEB_APP_VERSION } from '../appVersion.ts';
import { WEB_CLIENT_PROFILE } from '../clientProfile.ts';
import { shouldShowInstallPrompt } from './register.ts';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function standaloneDisplay(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function PwaInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (WEB_CLIENT_PROFILE.kind === 'android-bundled') return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDismissed(false);
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setPromptEvent(null);
      setDismissed(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const visible = useMemo(() => !dismissed && shouldShowInstallPrompt({
    profile: WEB_CLIENT_PROFILE.kind,
    deferredPrompt: promptEvent,
    displayMode: standaloneDisplay() ? 'standalone' : 'browser',
  }), [dismissed, promptEvent]);

  if (!visible || !promptEvent) return null;
  const install = async () => {
    setInstalling(true);
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
      setPromptEvent(null);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <aside className="pwa-install-prompt" aria-label="安装酒馆应用">
      <div>
        <strong>安装酒馆</strong>
        <span>v{WEB_APP_VERSION} · 添加到主屏幕，不复制电脑端数据</span>
      </div>
      <button type="button" onClick={() => void install()} disabled={installing}>
        {installing ? '处理中…' : '安装'}
      </button>
      <button type="button" className="pwa-install-dismiss" aria-label="暂不安装" onClick={() => setDismissed(true)}>×</button>
    </aside>
  );
}
