import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { initGlobalLogger } from './lib/logger.ts';
import './style.css';

initGlobalLogger();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary scope="sys">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
