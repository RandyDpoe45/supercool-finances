import { test } from '@playwright/test';
import { E2E_ENABLED } from './env';

/**
 * PENDING mechanism. `describe.fixme` registers the suite (so `playwright test --list` still
 * enumerates every spec) but never runs its bodies — no fixtures, no browser launch — until
 * the real stack + seed exist. Spec 08 sets `E2E_ENABLED=1` to resolve this to the live
 * `test.describe` and run for real. Both share the `(title, body)` call signature; the
 * explicit annotation keeps the union callable under strict TypeScript.
 */
export const e2eDescribe: (title: string, body: () => void) => void = E2E_ENABLED
  ? test.describe
  : test.describe.fixme;
