import { configureStore } from '@reduxjs/toolkit';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Make the same-origin `/balance/admin` base absolute before baseApi captures the env at import
// (identical to the other suites); MSW still matches its relative handlers against the same origin.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

import { baseApi } from '../src/services/api/baseApi';
import { approvalsApi } from '../src/services/api/approvalsApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { fixtureWhoami } from '../src/mocks/fixtures/identity';
import {
  TX_INBOUND_POSTED,
  TX_INTERNAL_POSTED,
  TX_OUTBOUND_POSTED,
} from '../src/mocks/fixtures/transactions';
import { APPROVAL_EXECUTED, APPROVAL_REJECTED } from '../src/mocks/fixtures/approvals';
import type { ApprovalRequestDto } from '../src/services/api/contracts/approval';

/**
 * Direct stub/contract tests for the maker-checker reversal endpoints — the guard branches the happy
 * UI path cannot reach. Dispatching `endpoints.*.initiate` on the REAL store hits the live MSW stub
 * (no `server.use` override), proving the stub mirrors the balance-service `/admin` wire contract:
 * the exact domain CODE + HTTP STATUS for each failure (spec 04 "Admin ops", `domain-error-status.ts`).
 * A regression in the stub's validation — or a client that smuggles maker/target through the body —
 * would otherwise go uncaught. Expected codes/statuses come from the SPEC, not the stub's source.
 */

// A well-formed uuid that is NOT any seeded transaction/approval id.
const UNKNOWN_UUID = 'dddddddd-0000-4000-8000-00000000dead';

interface StubError {
  error: { status: number; data: { error: { code: string } } };
}

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'reversals-api-access-token',
      token_type: 'Bearer',
      session_state: null,
      scope: 'openid profile',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      profile: {
        sub: 'admin-subject-123',
        iss: 'http://keycloak.localtest.me:8082/realms/supercool',
        aud: 'supercool-api',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      },
    }),
  );
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
});

describe('reversals stub — propose guards', () => {
  it('duplicate guard: proposing a reversal for a target that ALREADY has a pending approval → 409 REVERSAL_ALREADY_REQUESTED', async () => {
    const store = makeStore();
    // TX_INTERNAL_POSTED already carries the seed PENDING approval, so a fresh propose is a duplicate.
    const result = await store.dispatch(
      approvalsApi.endpoints.proposeReversal.initiate({ transactionId: TX_INTERNAL_POSTED }),
    );
    expect('error' in result).toBe(true);
    const { error } = result as StubError;
    expect(error.status).toBe(409);
    expect(error.data.error.code).toBe('REVERSAL_ALREADY_REQUESTED');
  });

  it('not reversible: proposing against a POSTED external_outbound tx → 409 TRANSACTION_NOT_REVERSIBLE', async () => {
    const store = makeStore();
    const result = await store.dispatch(
      approvalsApi.endpoints.proposeReversal.initiate({ transactionId: TX_OUTBOUND_POSTED }),
    );
    expect('error' in result).toBe(true);
    const { error } = result as StubError;
    expect(error.status).toBe(409);
    expect(error.data.error.code).toBe('TRANSACTION_NOT_REVERSIBLE');
  });

  it('missing target: proposing against an unknown transaction uuid → 404 TRANSFER_NOT_FOUND', async () => {
    const store = makeStore();
    const result = await store.dispatch(
      approvalsApi.endpoints.proposeReversal.initiate({ transactionId: UNKNOWN_UUID }),
    );
    expect('error' in result).toBe(true);
    const { error } = result as StubError;
    expect(error.status).toBe(404);
    expect(error.data.error.code).toBe('TRANSFER_NOT_FOUND');
  });
});

describe('reversals stub — decide guards', () => {
  it('approving a non-pending (EXECUTED / REJECTED) approval → 409 APPROVAL_NOT_PENDING', async () => {
    const store = makeStore();

    const executed = await store.dispatch(
      approvalsApi.endpoints.approveReversal.initiate(APPROVAL_EXECUTED),
    );
    expect('error' in executed).toBe(true);
    expect((executed as StubError).error.status).toBe(409);
    expect((executed as StubError).error.data.error.code).toBe('APPROVAL_NOT_PENDING');

    const rejected = await store.dispatch(
      approvalsApi.endpoints.approveReversal.initiate(APPROVAL_REJECTED),
    );
    expect('error' in rejected).toBe(true);
    expect((rejected as StubError).error.data.error.code).toBe('APPROVAL_NOT_PENDING');
  });

  it('approving / rejecting an unknown approval uuid → 404 APPROVAL_NOT_FOUND', async () => {
    const store = makeStore();

    const approve = await store.dispatch(
      approvalsApi.endpoints.approveReversal.initiate(UNKNOWN_UUID),
    );
    expect('error' in approve).toBe(true);
    expect((approve as StubError).error.status).toBe(404);
    expect((approve as StubError).error.data.error.code).toBe('APPROVAL_NOT_FOUND');

    const reject = await store.dispatch(
      approvalsApi.endpoints.rejectReversal.initiate(UNKNOWN_UUID),
    );
    expect('error' in reject).toBe(true);
    expect((reject as StubError).error.data.error.code).toBe('APPROVAL_NOT_FOUND');
  });
});

describe('reversals stub — malformed path (ParseUUIDPipe contract)', () => {
  it('a malformed uuid in the reverse / approve / reject path → 400 BAD_REQUEST', async () => {
    const store = makeStore();

    const reverse = await store.dispatch(
      approvalsApi.endpoints.proposeReversal.initiate({ transactionId: 'not-a-uuid' }),
    );
    expect('error' in reverse).toBe(true);
    expect((reverse as StubError).error.status).toBe(400);
    expect((reverse as StubError).error.data.error.code).toBe('BAD_REQUEST');

    const approve = await store.dispatch(
      approvalsApi.endpoints.approveReversal.initiate('not-a-uuid'),
    );
    expect((approve as StubError).error.status).toBe(400);
    expect((approve as StubError).error.data.error.code).toBe('BAD_REQUEST');

    const reject = await store.dispatch(
      approvalsApi.endpoints.rejectReversal.initiate('not-a-uuid'),
    );
    expect((reject as StubError).error.status).toBe(400);
    expect((reject as StubError).error.data.error.code).toBe('BAD_REQUEST');
  });
});

describe('reversals stub — param-smuggling defense on the reverse body', () => {
  it('an unknown reverse body key (e.g. a smuggled makerId) → 400 BAD_REQUEST (.strict() body)', async () => {
    // The RTK client only ever forwards `reason`, so a smuggled key can only be exercised with a raw
    // request. A VALID existing target uuid is used so the ONLY defect is the extra body key.
    const response = await fetch(
      `${window.location.origin}/balance/admin/transfers/${TX_INBOUND_POSTED}/reverse`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer smuggle-test', 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'looks legit',
          makerId: 'sneaky',
          targetTransactionId: 'x',
        }),
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('the CLIENT forwards ONLY the reason — never maker/target in the body', async () => {
    // Capture whatever body the proposeReversal mutation actually sends over the wire.
    let bodyWithReason: unknown = 'UNSET';
    let bodyWithoutReason: unknown = 'UNSET';
    const okApproval: ApprovalRequestDto = {
      id: '11111111-1111-4111-8111-1111111111ff',
      actionType: 'reversal',
      status: 'PENDING',
      makerId: fixtureWhoami.userId,
      checkerId: null,
      targetTransactionId: TX_INBOUND_POSTED,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      executedAt: null,
    };

    server.use(
      http.post('/balance/admin/transfers/:id/reverse', async ({ request }) => {
        const captured = await request.json().catch(() => 'NO_BODY');
        if (captured !== 'NO_BODY' && (captured as { reason?: unknown }).reason !== undefined) {
          bodyWithReason = captured;
        } else {
          bodyWithoutReason = captured;
        }
        return HttpResponse.json(okApproval, { status: 201 });
      }),
    );

    const store = makeStore();
    await store.dispatch(
      approvalsApi.endpoints.proposeReversal.initiate({
        transactionId: TX_INBOUND_POSTED,
        reason: 'legit reason',
      }),
    );
    await store.dispatch(
      approvalsApi.endpoints.proposeReversal.initiate({ transactionId: TX_INBOUND_POSTED }),
    );

    // With a reason: the body is EXACTLY { reason } — no makerId, no targetTransactionId.
    expect(bodyWithReason).toEqual({ reason: 'legit reason' });
    // Without a reason: no body at all (the client sends nothing to smuggle).
    expect(bodyWithoutReason).toBe('NO_BODY');
  });
});
