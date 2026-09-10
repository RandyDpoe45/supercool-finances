import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Dev-only: allow the MSW service worker (served under the `/otp/` base) to claim the
 * ROOT scope. API calls go to same-origin `/api` (origin root, matching the public
 * nginx topology), which is outside the `/otp/` scope, so the worker must be
 * registered with `scope: '/'`. The browser only honours a broader-than-path scope
 * when the script response carries `Service-Worker-Allowed`. `configureServer` runs
 * only under `vite dev`, so this never affects the production build.
 */
function serviceWorkerRootScope(): Plugin {
  return {
    name: 'msw-service-worker-root-scope',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith('/mockServiceWorker.js')) {
          res.setHeader('Service-Worker-Allowed', '/');
        }
        next();
      });
    },
  };
}

// The OTP app is served under the `/otp` base path on the public plane, so the whole
// bundle (and the OIDC redirect) lives at `http://localhost:8080/otp/`. `base` sets
// the asset + router base; the dev server is pinned to :8080 with strictPort so the
// redirect_uri (origin + `/otp/`) matches the Keycloak `otp-app` client's allowlisted
// `http://localhost:8080/otp/*` (tools/keycloak/realm-export.json). If the port is
// taken, fail loudly rather than drift to a non-allowlisted origin.
export default defineConfig({
  base: '/otp/',
  plugins: [react(), serviceWorkerRootScope()],
  server: {
    host: true,
    port: 8080,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true,
  },
});
