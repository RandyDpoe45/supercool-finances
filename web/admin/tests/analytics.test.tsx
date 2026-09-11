import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative service-namespaced bases; make BOTH bases
// absolute against the test origin BEFORE the api slices capture the env at import. The analytics
// dashboard talks to a SECOND slice (`analyticsApi`) on the distinct `/analytics/admin` namespace, so
// we stub that base too; the balance base is stubbed for parity with the other suites. MSW resolves
// its relative handlers against the same origin, so requests still match.
vi.hoisted(() => {
  vi.stubEnv('VITE_ANALYTICS_API_BASE_URL', `${window.location.origin}/analytics/admin`);
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

import { AnalyticsPage } from '../src/components/pages/AnalyticsPage';
import { baseApi } from '../src/services/api/baseApi';
import {
  analyticsApi,
  type AccountSummariesFilter,
  type DailyAggregatesFilter,
} from '../src/services/api/analyticsApi';
import type { AccountSummaryDto, DailyAggregateDto } from '../src/services/api/contracts/analytics';
import { formatAmount, formatMoney } from '../src/lib/money';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';

/**
 * Analytics dashboard (Step A5, route `/analytics`) over a fresh store + live MSW stub + a REAL
 * signed-in session. It consumes the analytics server (spec 05) via a SECOND RTK Query slice
 * (`analyticsApi`, reducerPath `analyticsApi`) on the `/analytics/admin` namespace, so the store
 * registers BOTH slices. Nothing here mocks the queries or the money/date helpers. These prove the
 * SPEC behaviors an analyst relies on (spec 07 admin-app + DATA-MODEL Part 2), with the sharp,
 * money-safety-adjacent proofs being:
 *
 *  - int64 money precision survives the wire → render path (a `Number()` coercion would round a
 *    value above 2^53 and is caught by an exact digit comparison);
 *  - the daily-aggregate `date` is a UTC day LABEL rendered VERBATIM, never timezone-shifted.
 *
 * Filtered MEMBERSHIP and expected counts are derived from the ground truth FETCHED THROUGH THE
 * ENDPOINT and re-filtered here per the SPEC, never read back from the component's own output.
 */

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);
const DAILY_TABLE = { name: 'daily aggregates' } as const;
const SUMMARIES_TABLE = { name: 'account summaries' } as const;

function makeStore() {
  // Fresh store per render so neither slice's RTK Query cache bleeds across tests.
  return configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
      [analyticsApi.reducerPath]: analyticsApi.reducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(baseApi.middleware).concat(analyticsApi.middleware),
  });
}

function renderPage() {
  return render(
    <Provider store={makeStore()}>
      <AnalyticsPage />
    </Provider>,
  );
}

/** The report SECTION (a `<section>`) that owns a given `<h2>`, so a section's filter controls (which
 * share label text — e.g. "Currency" — and an "Apply" button with the other section) can be scoped. */
function sectionFor(heading: string): HTMLElement {
  const h2 = screen.getByRole('heading', { name: heading, level: 2 });
  const section = h2.closest('section');
  if (!section) {
    throw new Error(`no <section> ancestor for heading "${heading}"`);
  }
  return section as HTMLElement;
}

const dailySection = () => sectionFor('Daily aggregates');
const summariesSection = () => sectionFor('Account summaries');

/** Read every rendered daily-aggregate row as `{ date, currency, type }` from its cells (the visible
 * table content, not the source data). */
function renderedDailyRows(): { date: string; currency: string; type: string }[] {
  const rows = document.querySelectorAll<HTMLElement>(
    'table[aria-label="daily aggregates"] tbody tr',
  );
  return [...rows].map((tr) => {
    const tds = tr.querySelectorAll('td');
    return {
      date: tds[0]?.textContent?.trim() ?? '',
      currency: tds[1]?.textContent?.trim() ?? '',
      type: tds[2]?.textContent?.trim() ?? '',
    };
  });
}

const dailyKey = (r: { date: string; currency: string; type: string }) =>
  `${r.date}|${r.currency}|${r.type}`;

/** The `data-account-id` of each rendered account-summary row, top to bottom. */
function renderedSummaryIds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('table[aria-label="account summaries"] tbody tr'),
  ].map((tr) => tr.getAttribute('data-account-id') ?? '');
}

/** Read the CURRENT rows straight off the stub (throwaway store, no cache subscription) — the
 * fixtures' ground truth for the counts / membership proofs. */
async function fetchSummaries(arg?: AccountSummariesFilter): Promise<AccountSummaryDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    analyticsApi.endpoints.getAccountSummaries.initiate(arg, {
      subscribe: false,
      forceRefetch: true,
    }),
  );
  return result.data ?? [];
}

async function fetchDaily(arg?: DailyAggregatesFilter): Promise<DailyAggregateDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    analyticsApi.endpoints.getDailyAggregates.initiate(arg, {
      subscribe: false,
      forceRefetch: true,
    }),
  );
  return result.data ?? [];
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'analytics-access-token',
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

describe('AnalyticsPage — both reports render with human money', () => {
  it('renders the daily-aggregates and account-summaries tables with all seeded rows', async () => {
    const daily = await fetchDaily({ limit: 200, offset: 0 });
    const summaries = await fetchSummaries({ limit: 200, offset: 0 });
    // The seeds fit inside one default page window, so the whole report is observable at once.
    expect(daily.length).toBeGreaterThanOrEqual(3);
    expect(daily.length).toBeLessThanOrEqual(50);
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    expect(summaries.length).toBeLessThanOrEqual(50);

    renderPage();
    await screen.findByRole('table', DAILY_TABLE);
    await screen.findByRole('table', SUMMARIES_TABLE);

    expect(renderedDailyRows().length).toBe(daily.length);
    expect(renderedSummaryIds().length).toBe(summaries.length);
  });

  it('renders money in human/currency form (not the raw minor-unit string)', async () => {
    const summaries = await fetchSummaries({ limit: 200, offset: 0 });
    const daily = await fetchDaily({ limit: 200, offset: 0 });

    // A known small account balance and a known daily total, with amounts modest enough that the
    // grouped human form is unambiguous. Derived from the fetched ground truth, not hardcoded.
    const summary = summaries.find((s) => s.lastBalanceAfter === '1500000');
    expect(summary, 'seed carries the 1,500,000-minor balance').toBeDefined();
    const aggregate = daily.find((d) => d.totalAmount === '980000');
    expect(aggregate, 'seed carries the 980,000-minor daily total').toBeDefined();

    renderPage();
    const summariesTable = await screen.findByRole('table', SUMMARIES_TABLE);
    const dailyTable = await screen.findByRole('table', DAILY_TABLE);

    const summaryRow = summariesTable.querySelector<HTMLElement>(
      `[data-account-id="${summary!.accountId}"]`,
    );
    expect(summaryRow).not.toBeNull();
    // Human form present; the raw minor-unit string never reaches the DOM.
    expect(summaryRow!.textContent).toContain(formatAmount('1500000', 'MXN')); // 15,000.00
    expect(summaryRow!.textContent).not.toContain('1500000');

    // The daily total renders WITH the ISO code (the organism uses `Money showCode`).
    expect(within(dailyTable).getByText(formatMoney('980000', 'MXN'))).toBeInTheDocument(); // 9,800.00 MXN
    expect(dailyTable.textContent).not.toContain('980000');
  });
});

describe('AnalyticsPage — daily-aggregate type filter narrows the list', () => {
  it("applies a type and shows ONLY that type's rows", async () => {
    const all = await fetchDaily({ limit: 200, offset: 0 });
    const type = 'external_outbound';
    const expectedKeys = all
      .filter((r) => r.type === type)
      .map((r) => `${r.date}|${r.currency}|${r.type}`)
      .sort();
    expect(expectedKeys.length, 'seed exercises external_outbound').toBeGreaterThan(0);
    expect(expectedKeys.length, 'seed also has other types (true narrowing)').toBeLessThan(
      all.length,
    );
    // A concrete other-type row that must disappear once filtered.
    const otherTypeRow = all.find((r) => r.type !== type);
    expect(otherTypeRow).toBeDefined();

    renderPage();
    await screen.findByRole('table', DAILY_TABLE);

    fireEvent.change(within(dailySection()).getByLabelText('Type'), { target: { value: type } });
    fireEvent.click(within(dailySection()).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(renderedDailyRows().map(dailyKey).sort()).toEqual(expectedKeys));
    // Every rendered row is the chosen type; the other-type row is gone.
    expect(renderedDailyRows().every((r) => r.type === type)).toBe(true);
    expect(renderedDailyRows().map(dailyKey)).not.toContain(
      `${otherTypeRow!.date}|${otherTypeRow!.currency}|${otherTypeRow!.type}`,
    );
  });
});

describe('AnalyticsPage — daily-aggregate from/to date-range filter', () => {
  it('applies an inclusive day window and shows only in-range dates', async () => {
    const all = await fetchDaily({ limit: 200, offset: 0 });
    const dates = [...new Set(all.map((r) => r.date))].sort();
    expect(dates.length, 'seed spans several distinct day buckets').toBeGreaterThanOrEqual(4);

    // Drop the earliest AND latest bucket so the window is a true narrowing on both ends.
    const from = dates[1];
    const to = dates[dates.length - 2];
    const expectedKeys = all
      .filter((r) => r.date >= from && r.date <= to)
      .map(dailyKey)
      .sort();
    expect(expectedKeys.length).toBeGreaterThan(0);
    expect(expectedKeys.length).toBeLessThan(all.length);

    renderPage();
    await screen.findByRole('table', DAILY_TABLE);

    fireEvent.change(within(dailySection()).getByLabelText('From'), { target: { value: from } });
    fireEvent.change(within(dailySection()).getByLabelText('To'), { target: { value: to } });
    fireEvent.click(within(dailySection()).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(renderedDailyRows().map(dailyKey).sort()).toEqual(expectedKeys));
    // Every rendered date is within [from, to]; the dropped earliest/latest buckets are absent.
    expect(renderedDailyRows().every((r) => r.date >= from && r.date <= to)).toBe(true);
    expect(renderedDailyRows().map((r) => r.date)).not.toContain(dates[0]);
    expect(renderedDailyRows().map((r) => r.date)).not.toContain(dates[dates.length - 1]);
  });
});

describe('AnalyticsPage — account-summary ownerId filter narrows the list', () => {
  it("applies an ownerId and shows ONLY that owner's summaries (system/null-owner rows excluded)", async () => {
    const all = await fetchSummaries({ limit: 200, offset: 0 });
    const owner = all.find((r) => r.ownerId !== null)?.ownerId;
    expect(owner, 'seed has an owned (non-system) summary').toBeDefined();

    const expectedIds = all
      .filter((r) => r.ownerId === owner)
      .map((r) => r.accountId)
      .sort();
    expect(expectedIds.length).toBeGreaterThan(0);
    expect(expectedIds.length, 'seed has other owners / system rows (true narrowing)').toBeLessThan(
      all.length,
    );
    // A null-owner system row that must disappear once filtered to a concrete owner.
    const systemRow = all.find((r) => r.ownerId === null);
    expect(systemRow, 'seed has a null-owner system summary').toBeDefined();

    renderPage();
    await screen.findByRole('table', SUMMARIES_TABLE);

    fireEvent.change(within(summariesSection()).getByLabelText('Owner ID'), {
      target: { value: owner },
    });
    fireEvent.click(within(summariesSection()).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(renderedSummaryIds().slice().sort()).toEqual(expectedIds));
    expect(renderedSummaryIds()).not.toContain(systemRow!.accountId);
  });
});

describe('AnalyticsPage — int64 money precision (money-safety)', () => {
  it('renders a >2^53 money value WITHOUT float coercion, in both reports', async () => {
    // A minor-unit value one centavo ABOVE Number.MAX_SAFE_INTEGER (2^53 = 9007199254740992). A
    // renderer that ran it through Number()/parseFloat would round to ...740992; the digit-exact
    // comparison below catches that. Digits-only of a formatted amount recovers the original
    // minor-unit integer, so the check is agnostic to grouping / decimal / currency-code formatting.
    const BIG = '9007199254740993';
    const LOSSY = String(Number(BIG)); // '9007199254740992' — proves Number() actually loses it here
    expect(Number.isSafeInteger(Number(BIG))).toBe(false);
    expect(LOSSY).not.toBe(BIG);

    const summaries = await fetchSummaries({ limit: 200, offset: 0 });
    const daily = await fetchDaily({ limit: 200, offset: 0 });
    const bigSummary = summaries.find((s) =>
      [s.lastBalanceAfter, s.totalDebited, s.totalCredited].includes(BIG),
    );
    const bigDaily = daily.find((d) => d.totalAmount === BIG);
    // If the fixtures lack a >2^53 value this fails LOUDLY (a gap to report), not silently weakens.
    expect(bigSummary, 'account-summaries fixtures carry a >2^53 money value').toBeDefined();
    expect(bigDaily, 'daily-aggregates fixtures carry a >2^53 money value').toBeDefined();

    renderPage();
    const summariesTable = await screen.findByRole('table', SUMMARIES_TABLE);
    await screen.findByRole('table', DAILY_TABLE);

    // Account-summaries row that carries the big value.
    const summaryRow = summariesTable.querySelector<HTMLElement>(
      `[data-account-id="${bigSummary!.accountId}"]`,
    );
    expect(summaryRow).not.toBeNull();
    const summaryDigits = (summaryRow!.textContent ?? '').replace(/\D/g, '');
    expect(summaryDigits).toContain(BIG);
    expect(summaryDigits).not.toContain(LOSSY);

    // Daily-aggregate row that carries the big value (matched by its date + type).
    const dailyRow = [
      ...document.querySelectorAll<HTMLElement>('table[aria-label="daily aggregates"] tbody tr'),
    ].find((tr) => {
      const tds = tr.querySelectorAll('td');
      return (
        tds[0]?.textContent?.trim() === bigDaily!.date &&
        tds[2]?.textContent?.trim() === bigDaily!.type
      );
    });
    expect(dailyRow, 'the >2^53 daily row rendered').not.toBeUndefined();
    const dailyDigits = (dailyRow!.textContent ?? '').replace(/\D/g, '');
    expect(dailyDigits).toContain(BIG);
    expect(dailyDigits).not.toContain(LOSSY);
  });
});

describe('AnalyticsPage — daily-aggregate date rendered verbatim (no TZ shift)', () => {
  it('shows each YYYY-MM-DD day label exactly, never timezone-converted', async () => {
    const all = await fetchDaily({ limit: 200, offset: 0 });
    const fixtureDates = all.map((r) => r.date).sort();
    const minDate = fixtureDates[0];
    // The UTC-midnight instant of the earliest day, shifted to Mexico City (UTC-6), lands on the
    // PREVIOUS calendar day — the classic day-bucket TZ bug. That shifted label must NOT appear.
    const dayBefore = new Date(`${minDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const shifted = dayBefore.toISOString().slice(0, 10);

    renderPage();
    await screen.findByRole('table', DAILY_TABLE);

    const renderedDates = renderedDailyRows().map((r) => r.date);
    // Every rendered date cell is a bare YYYY-MM-DD label (a localized dd/mm/yyyy render would fail).
    expect(renderedDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    // The visible day labels are exactly the fixtures' — same set, verbatim.
    expect(renderedDates.slice().sort()).toEqual(fixtureDates);
    // The earliest bucket appears verbatim; its TZ-shifted (previous-day) label does not.
    expect(renderedDates).toContain(minDate);
    expect(renderedDates).not.toContain(shifted);
  });
});

describe('AnalyticsPage — pagination', () => {
  it('disables Prev and Next on a single short page for both sections', async () => {
    // Each seed is smaller than the 50-row page window, so each report is one short page: Prev
    // disabled (page 0) AND Next disabled (a short last page). A paging-math bug that enabled Next on
    // a short page would fail here.
    const daily = await fetchDaily({ limit: 200, offset: 0 });
    const summaries = await fetchSummaries({ limit: 200, offset: 0 });
    expect(daily.length).toBeLessThan(50);
    expect(summaries.length).toBeLessThan(50);

    renderPage();
    await screen.findByRole('table', DAILY_TABLE);
    await screen.findByRole('table', SUMMARIES_TABLE);

    for (const section of [dailySection(), summariesSection()]) {
      expect(within(section).getByRole('button', { name: 'Previous' })).toBeDisabled();
      expect(within(section).getByRole('button', { name: 'Next' })).toBeDisabled();
    }
  });

  it('advances the daily-aggregates offset by a FULL page on Next; a filter change resets to page 0', async () => {
    // A controlled stub whose FIRST page is full (Next enabled) and whose later pages are short
    // (Next disabled), so the section's paging MATH is observable regardless of the seed size — it
    // captures the limit/offset each daily request carried. Mirrors the AuditPage paging test. The
    // account-summaries section keeps hitting the live stub; we only override + assert on daily.
    const seen: { limit: number; offset: number }[] = [];
    const synth = (count: number, offset: number): DailyAggregateDto[] =>
      Array.from({ length: count }, (_, i) => {
        const n = offset + i;
        return {
          date: new Date(Date.UTC(2026, 0, 1) - n * 86_400_000).toISOString().slice(0, 10),
          currency: 'MXN',
          type: 'internal',
          count: 1,
          totalAmount: '1000',
        };
      });
    server.use(
      http.get('/analytics/admin/reports/daily-aggregates', ({ request }) => {
        const url = new URL(request.url);
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        seen.push({ limit, offset });
        // Page 0 → a FULL window (Next enabled); any later page → a short tail (Next disabled).
        const count = offset === 0 ? limit : 3;
        return HttpResponse.json({ dailyAggregates: synth(count, offset) });
      }),
    );

    renderPage();
    await screen.findByRole('table', DAILY_TABLE);

    // First page is full → Prev disabled (offset 0), Next enabled.
    expect(within(dailySection()).getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(within(dailySection()).getByRole('button', { name: 'Next' })).toBeEnabled();

    fireEvent.click(within(dailySection()).getByRole('button', { name: 'Next' }));

    // Next must advance the offset by exactly one full page (offset === limit), not by 1.
    await waitFor(() => expect(seen.some((r) => r.offset > 0 && r.offset === r.limit)).toBe(true));
    // The short next page then disables Next and enables Prev.
    await waitFor(() =>
      expect(within(dailySection()).getByRole('button', { name: 'Next' })).toBeDisabled(),
    );
    expect(within(dailySection()).getByRole('button', { name: 'Previous' })).toBeEnabled();

    // Changing a filter must reset paging to page 0 (offset 0), so a filter always starts newest.
    const priorCount = seen.length;
    fireEvent.change(within(dailySection()).getByLabelText('Type'), {
      target: { value: 'internal' },
    });
    fireEvent.click(within(dailySection()).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(seen.length).toBeGreaterThan(priorCount));
    expect(seen[seen.length - 1].offset).toBe(0);
  });
});

describe('AnalyticsPage — currency filter + Clear (daily aggregates)', () => {
  it('feeds the currency input to the query, and Clear restores the full unfiltered list', async () => {
    const all = await fetchDaily({ limit: 200, offset: 0 });
    const fullKeys = all.map(dailyKey).sort();
    expect(fullKeys.length).toBeGreaterThan(0);

    renderPage();
    await screen.findByRole('table', DAILY_TABLE);
    expect(renderedDailyRows().map(dailyKey).sort()).toEqual(fullKeys);

    // A currency no row uses must feed through to the query and empty the table — proving the
    // currency input is wired to the request (not ignored), independent of the seed's currency set.
    fireEvent.change(within(dailySection()).getByLabelText('Currency'), {
      target: { value: 'XTS' },
    });
    fireEvent.click(within(dailySection()).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(renderedDailyRows().length).toBe(0));

    // Clear (only shown while a filter is active) restores the full unfiltered list and hides itself.
    fireEvent.click(within(dailySection()).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(renderedDailyRows().map(dailyKey).sort()).toEqual(fullKeys));
    expect(within(dailySection()).queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});

describe('AnalyticsPage — loading + error states', () => {
  it('renders the heading + both tables with no alert on the happy path', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Analytics', level: 1 })).toBeInTheDocument();
    await screen.findByRole('table', DAILY_TABLE);
    await screen.findByRole('table', SUMMARIES_TABLE);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a loading affordance before data arrives', async () => {
    renderPage();
    // Both sections' queries are in flight on the first synchronous render — a loading state, no table.
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', DAILY_TABLE)).not.toBeInTheDocument();

    await screen.findByRole('table', DAILY_TABLE);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('surfaces a 500 on daily-aggregates as a section alert; the summaries section is unaffected', async () => {
    server.use(
      http.get('/analytics/admin/reports/daily-aggregates', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );

    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/failed to load daily aggregates/i);
    // The failed section shows no table; the independent summaries section still renders.
    expect(screen.queryByRole('table', DAILY_TABLE)).not.toBeInTheDocument();
    expect(await screen.findByRole('table', SUMMARIES_TABLE)).toBeInTheDocument();
  });
});
