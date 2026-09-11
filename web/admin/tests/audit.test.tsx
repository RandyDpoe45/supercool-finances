import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative `/balance/admin` base; make the SAME
// same-origin base absolute against the test origin before baseApi captures the env at import
// (identical to the accounts / reversals / whoami tests). MSW resolves its relative handlers against
// the same origin, so requests still match.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

// Importing the page also registers auditApi's injected endpoint on baseApi.
import { AuditPage } from '../src/components/pages/AuditPage';
import { baseApi } from '../src/services/api/baseApi';
import { auditApi, type AuditFilter } from '../src/services/api/auditApi';
import { AUDIT_ACTIONS, type AuditLogDto } from '../src/services/api/contracts/audit';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { fixtureAudit } from '../src/mocks/fixtures/audit';
import { fixtureWhoami } from '../src/mocks/fixtures/identity';

/**
 * The admin audit view (Step A4, route `/audit`) over a fresh store + live MSW stub + a REAL
 * signed-in session (so the RTK Query bearer is attached exactly as in production). Nothing here
 * mocks the query or the datetime helpers. These prove the SPEC behaviors an auditor relies on
 * (spec 04 "Admin ops" audit log + spec 07 admin-app):
 *
 *  - the log renders NEWEST-FIRST (the exact order the endpoint returns, including the numeric
 *    id-DESC tiebreak) — a re-sort or a dropped/duplicated row fails this;
 *  - the action + actorId filters NARROW the list to exactly the matching rows (a matching row
 *    present AND a known non-matching row absent), server-side;
 *  - `metadata` is DELIBERATELY surfaced (its key/value is readable) but the log is strictly
 *    READ-ONLY — the table exposes no control that edits an audit field;
 *  - offset pagination: Prev disabled on page 0, Next disabled on a short last page, clicking Next
 *    advances the offset by a full page, and changing a filter resets to page 0;
 *  - the empty state and the loading / `role="alert"` error states.
 *
 * The expected ORDER + filtered MEMBERSHIP are derived from the fixtures' ground truth (fetched
 * through the endpoint, then filtered/sorted here per the SPEC), NOT from the component's own output.
 */

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);
const AUDIT_TABLE = { name: 'audit log' } as const;

/** Spec ordering: `createdAt` DESC, then `id` DESC as a bigint-aware (numeric, not lexicographic)
 * tiebreak. */
function byNewestFirst(a: AuditLogDto, b: AuditLogDto): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.id === b.id ? 0 : BigInt(a.id) < BigInt(b.id) ? 1 : -1;
}

function makeStore() {
  // Fresh store per render so RTK Query's cache never bleeds across tests.
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderPage() {
  return render(
    <Provider store={makeStore()}>
      <AuditPage />
    </Provider>,
  );
}

/** Read the CURRENT audit rows straight off the stub (throwaway store, no cache subscription) — the
 * fixtures' ground truth for the ordering / filtering proofs. */
async function fetchAudit(arg?: AuditFilter): Promise<AuditLogDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    auditApi.endpoints.getAudit.initiate(arg, { subscribe: false, forceRefetch: true }),
  );
  return result.data ?? [];
}

/** The `data-audit-id` of each rendered row, top to bottom — the observable render order. */
function renderedRowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('table[aria-label="audit log"] tbody tr')].map(
    (tr) => tr.getAttribute('data-audit-id') ?? '',
  );
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'audit-access-token',
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

describe('AuditPage — renders the log newest-first', () => {
  it('renders every seeded entry in the endpoint order (createdAt DESC, numeric id tiebreak)', async () => {
    const all = await fetchAudit({ limit: 200, offset: 0 });
    expect(all.length).toBeGreaterThanOrEqual(2);
    // Fixtures fit on one default page, so the whole log is observable at once.
    expect(all.length).toBeLessThanOrEqual(50);

    const expectedOrder = [...all].sort(byNewestFirst).map((e) => e.id);

    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);

    // The DOM row order equals the spec newest-first order — a flipped/lexicographic sort, or a
    // dropped/duplicated row, breaks this exact-sequence equality.
    expect(renderedRowIds()).toEqual(expectedOrder);
  });
});

describe('AuditPage — the action filter narrows the list', () => {
  it("applies a chosen action and shows ONLY that action's rows", async () => {
    const all = await fetchAudit({ limit: 200, offset: 0 });
    const chosenAction = all[0].action;
    const otherAction = all.find((e) => e.action !== chosenAction)?.action;
    expect(otherAction, 'seed exercises ≥2 distinct actions').toBeDefined();

    const expectedIds = [...all]
      .filter((e) => e.action === chosenAction)
      .sort(byNewestFirst)
      .map((e) => e.id);
    expect(expectedIds.length).toBeGreaterThan(0);
    expect(expectedIds.length).toBeLessThan(all.length); // a true narrowing
    const nonMatchingId = all.find((e) => e.action === otherAction)!.id;

    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: chosenAction } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(renderedRowIds()).toEqual(expectedIds));
    // A matching row is present; a known non-matching action's row is gone.
    expect(renderedRowIds()).toContain(expectedIds[0]);
    expect(renderedRowIds()).not.toContain(nonMatchingId);
  });
});

describe('AuditPage — the actorId filter narrows the list', () => {
  it("applies an actorId and shows ONLY that actor's rows", async () => {
    const all = await fetchAudit({ limit: 200, offset: 0 });
    const actors = [...new Set(all.map((e) => e.actorId))];
    expect(actors.length, 'seed uses ≥2 actors').toBeGreaterThanOrEqual(2);
    // Ground-truth sanity: the logged-in admin is one of the acting admins in the seed.
    expect(actors).toContain(fixtureWhoami.userId);

    const chosenActor = all[0].actorId;
    const otherActor = actors.find((a) => a !== chosenActor)!;
    const expectedIds = [...all]
      .filter((e) => e.actorId === chosenActor)
      .sort(byNewestFirst)
      .map((e) => e.id);
    expect(expectedIds.length).toBeGreaterThan(0);
    expect(expectedIds.length).toBeLessThan(all.length); // some but not all
    const nonMatchingId = all.find((e) => e.actorId === otherActor)!.id;

    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);

    fireEvent.change(screen.getByLabelText('Actor ID'), { target: { value: chosenActor } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(renderedRowIds()).toEqual(expectedIds));
    expect(renderedRowIds()).not.toContain(nonMatchingId);
  });
});

describe('AuditPage — metadata is viewable but the log is read-only', () => {
  it("surfaces a row's metadata key/value in an expandable disclosure and exposes NO edit control", async () => {
    const all = await fetchAudit({ limit: 200, offset: 0 });
    // Find an entry whose metadata carries a scalar (string/number/boolean) key/value to assert on.
    const scalarPair = (md: Record<string, unknown>): [string, string] | null => {
      for (const [k, v] of Object.entries(md)) {
        if (v !== null && typeof v !== 'object') {
          return [k, String(v)];
        }
      }
      return null;
    };
    const withMeta = all.find((e) => e.metadata !== null && scalarPair(e.metadata) !== null);
    expect(withMeta, 'seed has an entry with scalar metadata').toBeDefined();
    const [key, valueText] = scalarPair(withMeta!.metadata!)!;

    renderPage();
    const table = await screen.findByRole('table', AUDIT_TABLE);

    const row = document.querySelector<HTMLElement>(`[data-audit-id="${withMeta!.id}"]`);
    expect(row, `row for audit entry ${withMeta!.id} rendered`).not.toBeNull();

    // The metadata is presented in a collapsible disclosure (collapsed by default = a view toggle,
    // not an editor). Expand it and confirm the key + its verbatim value are shown.
    const details = row!.querySelector('details');
    expect(details, 'metadata rendered in a <details> disclosure').not.toBeNull();
    expect(details!.open).toBe(false);
    fireEvent.click(within(row!).getByText('Details'));
    expect(details!.textContent).toContain(key);
    expect(details!.textContent).toContain(valueText);

    // READ-ONLY: the audit table exposes no field-entry or mutating control (the filter/paging
    // controls live OUTSIDE the table, so scoping here proves the LOG itself is not editable).
    expect(within(table).queryAllByRole('textbox')).toHaveLength(0);
    expect(table.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(
      within(table).queryByRole('button', { name: /save|edit|delete|remove|update|submit/i }),
    ).toBeNull();
  });

  it('renders an int64 metadata money value VERBATIM (no float coercion)', async () => {
    // Fixture id '13' carries `originalAmount: '9007199254740993'` — one centavo ABOVE
    // Number.MAX_SAFE_INTEGER (2^53). A renderer that ran it through `Number()`/`parseFloat`
    // would round to '9007199254740992' and this exact-string assertion would fail. This is the
    // int64 money-precision guarantee for the audit trail (money is a string end to end).
    const big = '9007199254740993';
    const entry = fixtureAudit.find(
      (e) => e.metadata !== null && (e.metadata as Record<string, unknown>).originalAmount === big,
    );
    expect(entry, 'seed carries an above-2^53 metadata money value').toBeDefined();

    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);

    const row = document.querySelector<HTMLElement>(`[data-audit-id="${entry!.id}"]`);
    expect(row, `row for audit entry ${entry!.id} rendered`).not.toBeNull();
    const details = row!.querySelector('details');
    expect(details, 'metadata rendered in a <details> disclosure').not.toBeNull();
    fireEvent.click(within(row!).getByText('Details'));
    // The full int64 string is present, and the rounded (precision-lost) value is NOT.
    expect(details!.textContent).toContain(big);
    expect(details!.textContent).not.toContain('9007199254740992');
  });

  it('renders an em-dash and NO disclosure for a null-target / null-metadata entry', async () => {
    // Fixture id '16' has null target and null metadata — the em-dash branch. A regression that
    // printed the literal 'null' or crashed on the null metadata would slip past the other tests.
    const nullEntry = fixtureAudit.find(
      (e) => e.metadata === null && e.targetType === null && e.targetId === null,
    );
    expect(nullEntry, 'seed has a null-target, null-metadata entry').toBeDefined();

    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);

    const row = document.querySelector<HTMLElement>(`[data-audit-id="${nullEntry!.id}"]`);
    expect(row, `row for audit entry ${nullEntry!.id} rendered`).not.toBeNull();
    // No metadata disclosure for a null-metadata row, and it renders the muted em-dash, not 'null'.
    expect(row!.querySelector('details')).toBeNull();
    expect(row!.textContent).toContain('—');
    expect(row!.textContent).not.toContain('null');
  });
});

describe('AuditPage — pagination', () => {
  it('disables both Prev and Next on a single short page (offset 0, fewer than a full window)', async () => {
    // The seed is smaller than the page window, so the whole log is one short page.
    const all = await fetchAudit({ limit: 200, offset: 0 });
    expect(all.length).toBeLessThan(50);

    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('clicking Next advances the offset by a full page; a filter change resets to page 0', async () => {
    // A controlled stub whose FIRST page is full (Next enabled) and whose later pages are short
    // (Next disabled), so the page's paging MATH is observable regardless of the seed size. It
    // captures the `limit`/`offset` each request carried.
    const seen: { limit: number; offset: number }[] = [];
    const synth = (count: number, offset: number): AuditLogDto[] =>
      Array.from({ length: count }, (_, i) => {
        const n = offset + i;
        return {
          id: String(100000 - n),
          actorId: 'admin-user-1',
          action: 'account.freeze',
          targetType: 'account',
          targetId: `acct-${n}`,
          metadata: null,
          createdAt: new Date(Date.UTC(2026, 0, 1) - n * 1000).toISOString(),
        };
      });
    server.use(
      http.get('/balance/admin/audit', ({ request }) => {
        const url = new URL(request.url);
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        seen.push({ limit, offset });
        // Page 0 → a FULL window (Next enabled); any later page → a short tail (Next disabled).
        const count = offset === 0 ? limit : 3;
        return HttpResponse.json({ entries: synth(count, offset) });
      }),
    );

    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);

    // First page is full → Prev disabled (offset 0), Next enabled (maybe more rows).
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Next must advance the offset by exactly one full page (offset === limit), not by 1.
    await waitFor(() => expect(seen.some((r) => r.offset > 0 && r.offset === r.limit)).toBe(true));
    // The short next page then disables Next and enables Prev.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();

    // Changing a filter must reset paging to page 0 (offset 0), so a filter always starts newest.
    const priorCount = seen.length;
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: AUDIT_ACTIONS[0] } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(seen.length).toBeGreaterThan(priorCount));
    expect(seen[seen.length - 1].offset).toBe(0);
  });
});

describe('AuditPage — empty state', () => {
  it('shows the empty state and no rows when a filter matches nothing', async () => {
    renderPage();
    await screen.findByRole('table', AUDIT_TABLE);
    expect(renderedRowIds().length).toBeGreaterThan(0); // baseline rows present

    fireEvent.change(screen.getByLabelText('Actor ID'), {
      target: { value: 'ghost-actor-not-seeded' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // The empty state replaces the table; zero audit rows remain. (A filter that were ignored would
    // still show the full log here.)
    expect(await screen.findByText('No audit entries.')).toBeInTheDocument();
    expect(screen.queryByRole('table', AUDIT_TABLE)).not.toBeInTheDocument();
    expect(renderedRowIds().length).toBe(0);
  });
});

describe('AuditPage — loading + error states', () => {
  it('renders the heading + table with no alert on the happy path', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    await screen.findByRole('table', AUDIT_TABLE);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a loading indicator before data arrives, then the table', async () => {
    server.use(
      http.get('/balance/admin/audit', async () => {
        await delay(40);
        return HttpResponse.json({ entries: fixtureAudit.slice(0, 5) });
      }),
    );

    renderPage();
    // The very first render (query in flight, no data yet) shows the loading affordance, not a table.
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByRole('table', AUDIT_TABLE)).not.toBeInTheDocument();

    await screen.findByRole('table', AUDIT_TABLE);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('surfaces a 500 as a role="alert" and renders no table', async () => {
    server.use(
      http.get('/balance/admin/audit', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );

    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/failed to load audit log/i);
    expect(screen.queryByRole('table', AUDIT_TABLE)).not.toBeInTheDocument();
  });
});
