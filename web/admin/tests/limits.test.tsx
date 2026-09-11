import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Make the same-origin `/balance/admin` base absolute before baseApi captures the env at import
// (identical to the other page tests); MSW still matches its relative handlers against the same
// origin.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

// Importing the page also registers limitsApi's injected endpoints on baseApi.
import { LimitsPage } from '../src/components/pages/LimitsPage';
import { baseApi } from '../src/services/api/baseApi';
import { limitsApi } from '../src/services/api/limitsApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { OWNER_TWO } from '../src/mocks/fixtures/accounts';
import type { LimitsDto, UpsertLimitsBody } from '../src/services/api/contracts/limits';

/**
 * Limits management over a fresh store + live MSW stub + a REAL signed-in session. Nothing here
 * mocks the query, the mutation, or the money helpers. These prove the SPEC behaviors of the limits
 * screen (spec 07 admin-app + spec 04 limits), with the sharp areas being (a) the money-VALUED caps
 * and (b) the scope⇒ownerId rule — an authorization-shaped invariant on which limit binds whom:
 *
 *  - the current global baseline + a customer override render with FLOAT-FREE caps and "uncapped"
 *    for null caps (raw minor units never reach the DOM);
 *  - the scope rule is enforced CLIENT-SIDE: `global` hides the owner field and a `customer` upsert
 *    is BLOCKED (no PUT) until an owner is supplied;
 *  - a valid submit sends each cap as its minor-unit string BYTE-FOR-BYTE (no major→minor ×100
 *    conversion), empty caps as `null`, and exactly the whitelisted keys — asserted on the body MSW
 *    actually received (a value-corrupting or field-leaking bug fails here);
 *  - a `400 INVALID_LIMITS` from the server surfaces to the operator and produces NO phantom
 *    success (the current-limits table is not optimistically updated).
 */

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderPage() {
  return render(
    <Provider store={makeStore()}>
      <LimitsPage />
    </Provider>,
  );
}

/** A well-formed LimitsDto for handlers that need to answer a successful upsert. */
function limitsRow(overrides: Partial<LimitsDto> = {}): LimitsDto {
  return {
    id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    scope: 'global',
    ownerId: null,
    currency: 'MXN',
    perTransactionMax: null,
    dailyMax: null,
    monthlyMax: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'limits-access-token',
      token_type: 'Bearer',
      session_state: null,
      scope: 'openid profile',
      expires_at: NOW_SECONDS() + 3600,
      profile: {
        sub: 'admin-subject-123',
        iss: 'http://keycloak.localtest.me:8082/realms/supercool',
        aud: 'supercool-api',
        exp: NOW_SECONDS() + 3600,
        iat: NOW_SECONDS(),
      },
    }),
  );
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
});

describe('LimitsPage — current limits render', () => {
  it('renders the global baseline + customer override with float-free caps and "uncapped" for null', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'limits' });

    // Hand-computed (MXN exponent 2) from the seed: global perTx/daily, customer perTx/monthly.
    expect(table.textContent).toContain('50,000.00'); // global perTransactionMax 5000000
    expect(table.textContent).toContain('100,000.00'); // global dailyMax 10000000
    expect(table.textContent).toContain('1,500.00'); // customer perTransactionMax 150000
    expect(table.textContent).toContain('20,000.00'); // customer monthlyMax 2000000

    // The two null caps (global monthly, customer daily) render as "uncapped", not 0 or blank.
    expect(within(table).getAllByText('uncapped')).toHaveLength(2);

    // Raw minor-unit strings must NEVER reach the DOM.
    expect(table.textContent).not.toContain('5000000');
    expect(table.textContent).not.toContain('10000000');
  });
});

describe('LimitsPage — the scope⇒ownerId rule (client-side)', () => {
  it('hides the owner field for a global limit and shows it only for a customer override', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'limits' });

    // Global (default): no owner field.
    expect(screen.queryByLabelText(/owner id/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'customer' } });
    expect(screen.getByLabelText(/owner id/i)).toBeInTheDocument();

    // Back to global: the owner field is gone again (so a global upsert can't carry one).
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'global' } });
    expect(screen.queryByLabelText(/owner id/i)).not.toBeInTheDocument();
  });

  it('BLOCKS a customer upsert with no owner: no PUT is sent and a required-owner error shows', async () => {
    let putCalled = false;
    server.use(
      http.put('/balance/admin/limits', () => {
        putCalled = true;
        return HttpResponse.json(limitsRow());
      }),
    );

    const { container } = renderPage();
    await screen.findByRole('table', { name: 'limits' });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'customer' } });

    const form = container.querySelector('form.limits-form');
    expect(form).not.toBeNull();
    // Submitting the form directly exercises the client-side guard (not just a disabled button).
    fireEvent.submit(form!);

    // The guard fired: the required-owner error is shown AND no request left the client.
    expect(await screen.findByText(/owner id is required/i)).toBeInTheDocument();
    expect(putCalled).toBe(false);
    // The Save control is disabled while the owner is missing.
    expect(screen.getByRole('button', { name: /save limits/i })).toBeDisabled();
  });

  it('sends the ownerId once a customer override is supplied', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put('/balance/admin/limits', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(limitsRow({ scope: 'customer', ownerId: OWNER_TWO }));
      }),
    );

    renderPage();
    await screen.findByRole('table', { name: 'limits' });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'customer' } });
    fireEvent.change(screen.getByLabelText(/owner id/i), { target: { value: OWNER_TWO } });
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body!.scope).toBe('customer');
    expect(body!.ownerId).toBe(OWNER_TWO);
  });
});

describe('LimitsPage — caps travel as minor-unit strings, unchanged', () => {
  it('sends each cap byte-for-byte (no ×100), empty as null, and exactly the whitelisted keys', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put('/balance/admin/limits', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(limitsRow({ perTransactionMax: '150000' }));
      }),
    );

    renderPage();
    await screen.findByRole('table', { name: 'limits' });

    // A caller enters MINOR units directly: '150000' means 1,500.00 and must NOT be scaled again.
    fireEvent.change(screen.getByLabelText(/per-transaction max/i), {
      target: { value: '150000' },
    });
    // Leave dailyMax empty -> must serialize as null (uncapped).
    // A monthly at the int64 ceiling proves the value survives without float corruption.
    fireEvent.change(screen.getByLabelText(/monthly max/i), {
      target: { value: '9223372036854775807' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }));

    await waitFor(() => expect(body).toBeDefined());

    // The wire body carries EXACTLY the whitelisted keys — never id/createdAt/status smuggled in.
    expect(Object.keys(body!).sort()).toEqual([
      'currency',
      'dailyMax',
      'monthlyMax',
      'ownerId',
      'perTransactionMax',
      'scope',
    ]);
    expect(body).toEqual({
      scope: 'global',
      ownerId: null, // global carries an explicit null owner
      currency: 'MXN',
      perTransactionMax: '150000', // byte-for-byte, NOT '15000000'
      dailyMax: null, // empty input -> uncapped
      monthlyMax: '9223372036854775807', // int64 ceiling preserved exactly
    });
  });

  it('reflects a successful global upsert in the table after invalidation (round-trip, not stale cache)', async () => {
    // No PUT override: the real stub upserts and the LIST invalidation refetches the new baseline.
    renderPage();
    const table = await screen.findByRole('table', { name: 'limits' });
    expect(table.textContent).toContain('50,000.00'); // old global perTransactionMax

    // 300000 minor = 3,000.00 — a value not present anywhere in the seed, so its appearance can
    // only come from the refetched, updated baseline.
    fireEvent.change(screen.getByLabelText(/per-transaction max/i), {
      target: { value: '300000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }));

    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'limits' }).textContent).toContain('3,000.00'),
    );
    // The old value is gone: the row was replaced, not duplicated / cached.
    expect(screen.getByRole('table', { name: 'limits' }).textContent).not.toContain('50,000.00');
  });
});

describe('LimitsPage — server rejection is surfaced with no phantom success', () => {
  it('shows the INVALID_LIMITS message and does NOT optimistically update the table', async () => {
    server.use(
      http.put('/balance/admin/limits', () =>
        HttpResponse.json(
          {
            error: {
              code: 'INVALID_LIMITS',
              message: 'Server rejected these limits.',
              requestId: 'r',
            },
          },
          { status: 400 },
        ),
      ),
    );

    renderPage();
    const table = await screen.findByRole('table', { name: 'limits' });

    fireEvent.change(screen.getByLabelText(/per-transaction max/i), {
      target: { value: '300000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }));

    // The server's error message reaches the operator...
    expect(await screen.findByText(/server rejected these limits/i)).toBeInTheDocument();
    // ...and the table is untouched — no phantom "3,000.00", the original baseline still stands.
    expect(table.textContent).not.toContain('3,000.00');
    expect(screen.getByRole('table', { name: 'limits' }).textContent).toContain('50,000.00');
  });
});

describe('LimitsPage — MSW stub validation (direct)', () => {
  // Hit the REAL stub (no server.use override) to prove its OWN guard branches, which the UI can't
  // reach: the client-side guard blocks a customer-without-owner PUT, so the stub's scope⇒ownerId
  // rejection (and its strict-body rejection) are only reachable by dispatching the endpoint
  // directly. A regression in the stub's validation would otherwise go uncaught.
  interface StubError {
    error: { status: number; data: { error: { code: string } } };
  }

  it('rejects a customer upsert with no ownerId as 400 INVALID_LIMITS (stub scope rule)', async () => {
    const store = makeStore();
    const result = await store.dispatch(
      limitsApi.endpoints.upsertLimits.initiate({ scope: 'customer', currency: 'MXN' }),
    );
    expect('error' in result).toBe(true);
    const { error } = result as StubError;
    expect(error.status).toBe(400);
    expect(error.data.error.code).toBe('INVALID_LIMITS');
  });

  it('rejects an unknown body key as 400 BAD_REQUEST (stub .strict() body)', async () => {
    const store = makeStore();
    const result = await store.dispatch(
      limitsApi.endpoints.upsertLimits.initiate({
        scope: 'global',
        currency: 'MXN',
        id: 'aaaaaaaa-0000-4000-8000-00000000000a',
      } as unknown as UpsertLimitsBody),
    );
    expect('error' in result).toBe(true);
    const { error } = result as StubError;
    expect(error.status).toBe(400);
    expect(error.data.error.code).toBe('BAD_REQUEST');
  });
});
