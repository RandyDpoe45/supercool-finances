import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The admin app is ROOT-served on its own dedicated internal origin (:8081). The dev
// server is pinned to :8081 with strictPort so the OIDC redirect_uri (derived from
// window.location.origin) matches the Keycloak `admin-app` client's allowlisted
// `http://localhost:8081/*` (tools/keycloak/realm-export.json). If the port is taken,
// fail loudly rather than drift to a non-allowlisted origin. (:8081 is the one place this
// differs from the customer SPA's :8080 — same root-served shape otherwise.)
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 8081,
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
