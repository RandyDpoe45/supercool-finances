import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

/**
 * Start the MSW browser stub before rendering, so the first `/balance/api` call in dev is
 * intercepted. Dev-only (never in a production build); `onUnhandledRequest: 'bypass'`
 * lets real OIDC traffic to Keycloak pass through untouched. The worker is served
 * from the `/otp` base, so its scope covers this app only.
 */
async function enableApiMocks(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_API_MOCKS === 'false') {
    return;
  }
  const { worker } = await import('./mocks/browser');
  // The worker script is served from the `/otp/` base, but it must intercept
  // origin-root `/balance/api` calls — hence the explicit URL plus root scope (the dev server
  // sends `Service-Worker-Allowed: /`; see vite.config.ts).
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: {
      url: `${import.meta.env.BASE_URL}mockServiceWorker.js`,
      options: { scope: '/' },
    },
  });
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
