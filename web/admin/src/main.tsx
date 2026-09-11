import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

/**
 * Start the MSW browser stub before rendering, so the first `/balance/admin` call in dev is
 * intercepted. Dev-only (never in a production build); `onUnhandledRequest: 'bypass'`
 * lets real OIDC traffic to Keycloak pass through untouched. The app is root-served, so
 * the worker claims root scope natively — no scope override needed.
 */
async function enableApiMocks(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_API_MOCKS === 'false') {
    return;
  }
  const { worker } = await import('./mocks/browser');
  await worker.start({ onUnhandledRequest: 'bypass' });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

void enableApiMocks().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
