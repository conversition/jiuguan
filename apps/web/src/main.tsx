import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthShell } from './AuthShell.tsx';
import { authClient } from './authClient.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { initGlobalLogger } from './lib/logger.ts';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';
import { PwaInstallPrompt } from './pwa/PwaInstallPrompt.tsx';
import { PwaUpdatePrompt } from './pwa/PwaUpdatePrompt.tsx';
import './style.css';

// Keep an explicit boot revision in the compiled shell. Besides making field
// diagnostics visible, changing it forces a fresh hashed asset after a failed
// PWA rollout instead of allowing a poisoned immutable cache entry to survive.
document.documentElement.dataset.jgBootRevision = '2026-09-28-r1';

void authClient.initialize();
initGlobalLogger();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary scope="sys">
      <AuthShell />
      <PwaInstallPrompt />
      {WEB_CLIENT_PROFILE.kind !== 'android-bundled' && <PwaUpdatePrompt />}
    </ErrorBoundary>
  </React.StrictMode>,
);
