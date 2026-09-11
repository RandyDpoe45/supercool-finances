import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './tests/e2e/fixtures/env';

/**
 * Playwright config for the client-app end-to-end suites (spec 07 DoD).
 *
 * SEPARATION FROM VITEST: `testDir` + `testMatch` scope Playwright to `tests/e2e/**` and to
 * the `*.e2e.ts` naming ONLY. Vitest's `include` (`tests/**\/*.{test,spec}.{ts,tsx}`) never
 * matches `*.e2e.ts`, so the two runners never see each other's files.
 *
 * These specs are PENDING until spec 08 (see tests/e2e/README.md): they are registered but
 * skipped (`describe.fixme`) so `playwright test --list` enumerates them without a running
 * stack or installed browsers. Serial (single worker) because the flows move real money and
 * share seeded account state.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
