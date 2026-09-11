import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetAdminState } from '../src/mocks/state/adminState';
import { server } from '../src/mocks/node';

// Test-runner wiring (not a test): jsdom matchers + MSW `/balance/admin` stub lifecycle. An
// unhandled request is an error so tests can't silently hit a network they meant to mock.
//
// The mutable admin stub state (account status, limits rows) lives at MODULE scope, so it SURVIVES
// `server.resetHandlers()`. `resetAdminState()` reseeds it from the pristine fixtures after every
// test, so a freeze/unfreeze/upsert side effect in one test can never bleed into the next.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetAdminState();
});
afterAll(() => server.close());
