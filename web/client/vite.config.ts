import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dev server is pinned to :8080 with strictPort so the OIDC redirect_uri
// (derived from window.location.origin) matches the Keycloak `client-app` client's
// allowlisted `http://localhost:8080/*` (tools/keycloak/realm-export.json). If the
// port is taken, fail loudly rather than drift to a non-allowlisted origin.
export default defineConfig({
  plugins: [react()],
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
