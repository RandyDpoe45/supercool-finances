import { test } from '@playwright/test';
import { E2E_ENABLED } from './env';

/**
 * PENDING mechanism. `describe.fixme` registers the suite (so `playwright test --list`
 * still enumerates every spec) but never runs its bodies — no fixtures, no browser launch —
 * which is exactly what we want until the real stack + seed exist. When spec 08 sets
 * `E2E_ENABLED=1`, this resolves to the live `test.describe` and the suites run for real.
 *
 * The two share the `(title, body)` call signature; the explicit annotation keeps the union
 * callable under strict TypeScript.
 */
export const e2eDescribe: (title: string, body: () => void) => void = E2E_ENABLED
  ? test.describe
  : test.describe.fixme;
