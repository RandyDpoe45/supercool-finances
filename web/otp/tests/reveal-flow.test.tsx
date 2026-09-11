import { configureStore } from '@reduxjs/toolkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetMockState, setMockPending } from '../src/mocks/state';
import type { PendingAuthorizationDto } from '../src/services/api/contracts/pending-authorization';

/**
 * The code-reveal flow, driven through the REAL panel/page + store + base query + UserManager
 * against live MSW (the deterministic dev code is `424242`, ttl 120s). This proves the
 * money-safety behaviours the spec/docs require:
 *  - reveal mints and shows the code ONCE, with its ttl countdown and the shown-once warning;
 *  - the SINGLETON gate: a second mint while a code is active is a 409 that surfaces a reason
 *    and never re-shows a code;
 *  - the plaintext is dropped when the ttl elapses (and the server slot frees so a fresh reveal
 *    works again);
 *  - reveal is WITHHELD (with a reason) when there is no pending or the pending has expired.
 *
 * Harness note: `VITE_API_BASE_URL` is stubbed to the absolute jsdom origin before the app
 * modules load (Node cannot fetch a relative base — see base-api-bearer.test.ts).
 */

const API_ORIGIN = window.location.origin;
const DEV_CODE = '424242';

let baseApiMod: typeof import('../src/services/api/baseApi');
let codeRevealMod: typeof import('../src/components/organisms/CodeRevealPanel');
let homePageMod: typeof import('../src/components/pages/HomePage');
let userManagerMod: typeof import('../src/auth/userManager');

function makeStore() {
  const { baseApi } = baseApiMod;
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderWith(node: ReactNode) {
  return render(<Provider store={makeStore()}>{node}</Provider>);
}

// Like `renderWith`, but exposes the store so a test can inspect RTK Query's in-memory
// mutation cache directly (`state.api.mutations`) — not just the DOM.
function renderWithStore(node: ReactNode) {
  const store = makeStore();
  return { store, ...render(<Provider store={store}>{node}</Provider>) };
}

// Serialize the RTK Query mutation slice and scan it for the plaintext code. The minted
// `{ code, ttlSeconds }` lives here (keyed by request id) until the mutation is `reset()`;
// this catches a code that lingers in the store even after the DOM stops showing it.
function mutationCacheHasCode(store: ReturnType<typeof makeStore>, code: string): boolean {
  return JSON.stringify(store.getState().api.mutations).includes(code);
}

function signIn(): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const user = new User({
    access_token: 'live-access-token',
    token_type: 'Bearer',
    expires_at: nowSeconds + 3600,
    profile: {
      sub: 'otp-user',
      iss: 'issuer',
      aud: 'otp-app',
      exp: nowSeconds + 3600,
      iat: nowSeconds,
    },
  });
  return userManagerMod.userManager.storeUser(user);
}

function pendingExpiringInMs(ms: number): PendingAuthorizationDto {
  return {
    transferId: '33333333-3333-4333-8333-333333333333',
    type: 'internal',
    amount: '125000',
    currency: 'MXN',
    sourceAccountId: '11111111-1111-4111-8111-111111111111',
    destinationAccountNumber: '1000000002',
    destinationMaskedName: 'Jua** Per**',
    payeeDisplayName: null,
    createdAt: '2026-09-10T18:00:00Z',
    expiresAt: new Date(Date.now() + ms).toISOString(),
  };
}

beforeAll(async () => {
  vi.stubEnv('VITE_API_BASE_URL', `${API_ORIGIN}/balance/api`);
  baseApiMod = await import('../src/services/api/baseApi');
  codeRevealMod = await import('../src/components/organisms/CodeRevealPanel');
  homePageMod = await import('../src/components/pages/HomePage');
  userManagerMod = await import('../src/auth/userManager');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  vi.useRealTimers();
  await userManagerMod.userManager.removeUser();
  resetMockState();
});

describe('CodeRevealPanel — reveal + singleton + ttl', () => {
  it('mints and shows the code once, with its ttl countdown and the shown-once warning', async () => {
    const { CodeRevealPanel } = codeRevealMod;
    await signIn();
    renderWith(<CodeRevealPanel disabledReason={null} />);

    fireEvent.click(screen.getByLabelText('reveal-code'));

    expect(await screen.findByLabelText('one-time-code')).toHaveTextContent(DEV_CODE);
    // The shown-once warning must be present (the server never re-reveals the code).
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
    // A ttl countdown (m:ss) accompanies the code.
    expect(screen.getByText(/^\d{1,2}:\d{2}$/)).toBeInTheDocument();
  });

  it('rejects a second mint while a code is active (409) with a reason, and never re-shows a code', async () => {
    const { CodeRevealPanel } = codeRevealMod;
    await signIn();

    // First reveal claims the server-side singleton slot.
    const first = renderWith(<CodeRevealPanel disabledReason={null} />);
    fireEvent.click(screen.getByLabelText('reveal-code'));
    expect(await screen.findByLabelText('one-time-code')).toHaveTextContent(DEV_CODE);

    // A fresh panel (e.g. a reload) whose local state has no code tries to mint again while the
    // slot is still active -> the server returns 409 OTP_ALREADY_ACTIVE.
    first.unmount();
    renderWith(<CodeRevealPanel disabledReason={null} />);
    fireEvent.click(screen.getByLabelText('reveal-code'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already active/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/shown once/i);
    // Crucially, no code is re-shown by the 409 path.
    expect(screen.queryByLabelText('one-time-code')).toBeNull();
    expect(document.body.textContent).not.toContain(DEV_CODE);
  });

  it('drops the plaintext code when the ttl elapses and frees the slot for a fresh reveal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { CodeRevealPanel } = codeRevealMod;
    await signIn();
    renderWith(<CodeRevealPanel disabledReason={null} />);

    fireEvent.click(screen.getByLabelText('reveal-code'));
    expect(await screen.findByLabelText('one-time-code')).toHaveTextContent(DEV_CODE);

    // Advance past the 120s ttl: the panel must drop the plaintext and re-offer reveal.
    await act(async () => {
      vi.advanceTimersByTime(121_000);
    });
    expect(await screen.findByLabelText('reveal-code')).toBeInTheDocument();
    expect(screen.queryByLabelText('one-time-code')).toBeNull();

    // The server slot has also freed (ttl lapsed), so a fresh reveal succeeds again.
    fireEvent.click(screen.getByLabelText('reveal-code'));
    expect(await screen.findByLabelText('one-time-code')).toHaveTextContent(DEV_CODE);
  });

  it('purges the minted code from RTK Query’s mutation cache when the ttl elapses, not just the DOM', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { CodeRevealPanel } = codeRevealMod;
    await signIn();
    const { store } = renderWithStore(<CodeRevealPanel disabledReason={null} />);

    fireEvent.click(screen.getByLabelText('reveal-code'));
    expect(await screen.findByLabelText('one-time-code')).toHaveTextContent(DEV_CODE);

    // Baseline: while active, the mutation result carries the plaintext in the store. This
    // proves the scan is live — the code really is findable in `state.api.mutations`.
    expect(mutationCacheHasCode(store, DEV_CODE)).toBe(true);

    // Advance past the 120s ttl. The panel must `reset()` the mutation in lockstep with
    // clearing local state, so the store copy is dropped too — not merely hidden. Without
    // that `reset()` the entry lingers (the hook keeps its subscription) and this fails.
    await act(async () => {
      vi.advanceTimersByTime(121_000);
    });
    expect(screen.queryByLabelText('one-time-code')).toBeNull();
    expect(mutationCacheHasCode(store, DEV_CODE)).toBe(false);
  });
});

describe('HomePage — reveal gating', () => {
  it('withholds reveal (with a reason) when there is no pending authorization', async () => {
    const { HomePage } = homePageMod;
    await signIn();
    setMockPending(null);
    renderWith(<HomePage />);

    expect(
      await screen.findByText(
        /There is no pending authorization, so there is nothing to authorize/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('reveal-code')).toBeNull();
  });

  it('withholds reveal (with an expiry reason) when the pending has already expired', async () => {
    const { HomePage } = homePageMod;
    await signIn();
    // An authorization whose 2-minute deadline is already in the past can no longer mint.
    setMockPending(pendingExpiringInMs(-1_000));
    renderWith(<HomePage />);

    expect(await screen.findByText(/This authorization has expired/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('reveal-code')).toBeNull();
  });
});
