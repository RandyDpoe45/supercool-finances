import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '../src/mocks/node';

// Test-runner wiring (not a test): jsdom matchers + MSW `/api` stub lifecycle. An
// unhandled request is an error so tests can't silently hit a network they meant to mock.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
