import type { AccountDto } from '../../services/api/contracts/accounts';
import type { PendingAuthorizationDto, TransferDto } from '../../services/api/contracts/transfers';
import { fixtureAccounts } from '../fixtures/accounts';
import { fixtureDestinations } from '../fixtures/destinations';

/**
 * In-memory transfer state for the MSW stub, mirroring the balance-service transfer lifecycle
 * closely enough to exercise the client flow end to end WITHOUT a backend: confirmation-of-payee
 * tokens, idempotent initiate (same key + same money tuple → the SAME transfer; same key + a
 * DIFFERENT tuple → key reuse, mirroring the service's `IdempotencyKeyReuseError` → 409), the
 * 60-second soft-duplicate window
 * (honoring `confirmDuplicate`), the single-active-pending rule (a new initiate auto-supersedes the
 * prior pending), the 2-minute pending deadline (lazy expiry), and OTP-gated confirm / cancel. This
 * spans BOTH internal transfers and external outbound (addressed by `payeeId`).
 *
 * The hold → cache-invalidation asymmetry is modeled faithfully: an INTERNAL transfer moves no money
 * until confirm, so the stub leaves balances untouched for it (the money-safety proof stays the
 * client's cache invalidation). An EXTERNAL outbound PLACES A HOLD at initiate (`held += amount`,
 * `available` drops), SETTLES it on confirm (`balance -= amount`, `held -= amount`), and RELEASES it
 * on cancel / expiry (`held -= amount`). Those deltas live in `accountAdjustments` and are folded
 * over the fixed accounts fixture by {@link projectAccounts}, so the demo + the external
 * cache-invalidation are coherent while the fixtures stay the pristine baseline after a reset.
 *
 * State lives at module scope (the worker + the node test server each get their own instance).
 * `resetTransferStore()` clears it — including the account adjustments — so a test starts from a
 * clean slate with pristine balances.
 */

/** The 2-minute pending authorization deadline, matching the service's `expires_at`. */
const PENDING_TTL_MS = 2 * 60 * 1000;
/** The 60-second soft-duplicate suppression window, matching the service. */
const DUPLICATE_WINDOW_MS = 60 * 1000;

interface ConfirmationRecord {
  destinationAccountNumber: string;
  destinationMaskedName: string;
  currency: string;
}

/** The reservation lifecycle of an external outbound's hold. Internal transfers carry none. */
type HoldState = 'PLACED' | 'SETTLED' | 'RELEASED';

interface StoredTransfer {
  dto: TransferDto;
  /** Internal: the destination account number / masked name. External: null (the payee is named). */
  destinationAccountNumber: string | null;
  destinationMaskedName: string | null;
  /** External: the enrolled payee's display label. Internal: null. */
  payeeDisplayName: string | null;
  fingerprint: string;
  /** External only: the hold's current reservation state (settled on confirm, released on cancel/expiry). */
  holdState?: HoldState;
}

/** The running balance/hold deltas an external outbound applies to a source account, folded over the
 * fixed fixture by {@link projectAccounts}. Stored as bigint minor units (never float). */
interface AccountAdjustment {
  heldDelta: bigint;
  balanceDelta: bigint;
}

interface TransferStoreState {
  /** confirmation token → the destination it binds to. */
  tokens: Map<string, ConfirmationRecord>;
  /** transfer id → the stored transfer. */
  byId: Map<string, StoredTransfer>;
  /**
   * Idempotency-Key → the created transfer id + the fingerprint of the INITIATING request, so a
   * later initiate under the same key mirrors the service's `resolveExisting`: a matching
   * fingerprint replays the original transfer, a DIFFERENT one is key reuse (never a silent replay).
   */
  byIdempotencyKey: Map<string, { transferId: string; fingerprint: string }>;
  /** request fingerprint → last-initiated epoch ms (soft-duplicate window). */
  recentFingerprints: Map<string, number>;
  /** the single active PENDING transfer id, or null. */
  activePendingId: string | null;
  /** account id → the external-hold balance/hold deltas layered over the fixtures. */
  accountAdjustments: Map<string, AccountAdjustment>;
}

function freshState(): TransferStoreState {
  return {
    tokens: new Map(),
    byId: new Map(),
    byIdempotencyKey: new Map(),
    recentFingerprints: new Map(),
    activePendingId: null,
    accountAdjustments: new Map(),
  };
}

let state: TransferStoreState = freshState();

/** Reset all transfer state (for test isolation). */
export function resetTransferStore(): void {
  state = freshState();
}

/** Resolve a destination account number to its masked name + currency + a fresh confirmation
 * token, or `null` when unknown (→ the caller returns a 404). */
export function resolveDestination(
  accountNumber: string,
): { maskedName: string; currency: string; confirmationToken: string } | null {
  const destination = fixtureDestinations.find((d) => d.accountNumber === accountNumber);
  if (!destination) {
    return null;
  }
  const confirmationToken = crypto.randomUUID();
  state.tokens.set(confirmationToken, {
    destinationAccountNumber: destination.accountNumber,
    destinationMaskedName: destination.maskedName,
    currency: destination.currency,
  });
  return {
    maskedName: destination.maskedName,
    currency: destination.currency,
    confirmationToken,
  };
}

export type InitiateResult =
  | { outcome: 'created' | 'replayed'; transfer: TransferDto }
  | { outcome: 'duplicate' }
  | { outcome: 'key-reused' }
  | { outcome: 'destination-not-confirmed' };

/** Initiate a PENDING internal transfer (no money moves), mirroring the service's idempotency +
 * soft-duplicate + confirmation-token + single-pending semantics. */
export function initiateTransfer(params: {
  idempotencyKey: string;
  sourceAccountId: string;
  destinationAccountNumber: string;
  amount: string;
  currency: string;
  confirmationToken: string;
  confirmDuplicate: boolean;
}): InitiateResult {
  // The request fingerprint — the SEMANTIC identity of the money movement (source + destination +
  // amount + currency), the same field set the balance-service `computeFingerprint` hashes. It
  // deliberately EXCLUDES `confirmDuplicate` (a control flag, not part of the money tuple), so a
  // "Send anyway" re-submit under the same key stays a safe replay rather than a reuse error.
  const fingerprint = `${params.sourceAccountId}|${params.destinationAccountNumber}|${params.amount}|${params.currency}`;

  // 1. Existing idempotency key → mirror the service's `resolveExisting`: a fingerprint MISMATCH is
  //    key reuse (409 IDEMPOTENCY_KEY_REUSED), NEVER a silent replay; a MATCH replays the ORIGINAL
  //    transfer (its current state), never a second creation — this is what makes a retry safe.
  const existing = state.byIdempotencyKey.get(params.idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return { outcome: 'key-reused' };
    }
    const stored = state.byId.get(existing.transferId);
    if (stored) {
      applyLazyExpiry(stored);
      return { outcome: 'replayed', transfer: stored.dto };
    }
  }

  // 2. Confirmation-of-payee gate: the token must exist AND bind to THIS destination.
  const confirmation = state.tokens.get(params.confirmationToken);
  if (!confirmation || confirmation.destinationAccountNumber !== params.destinationAccountNumber) {
    return { outcome: 'destination-not-confirmed' };
  }

  // 3. Soft duplicate: an identical payment within the window under a DIFFERENT key needs an
  //    explicit confirmDuplicate to proceed.
  const now = Date.now();
  const lastAt = state.recentFingerprints.get(fingerprint);
  if (!params.confirmDuplicate && lastAt !== undefined && now - lastAt < DUPLICATE_WINDOW_MS) {
    return { outcome: 'duplicate' };
  }

  // 4. Single active pending: a new initiate auto-supersedes the prior pending (→ CANCELLED),
  //    matching the service's behavior.
  if (state.activePendingId) {
    const prior = state.byId.get(state.activePendingId);
    if (prior && prior.dto.status === 'PENDING') {
      prior.dto = { ...prior.dto, status: 'CANCELLED' };
    }
  }

  // 5. Create the PENDING transfer with a 2-minute deadline.
  const id = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PENDING_TTL_MS).toISOString();
  const dto: TransferDto = {
    id,
    type: 'internal',
    status: 'PENDING',
    amount: params.amount,
    currency: params.currency,
    sourceAccountId: params.sourceAccountId,
    createdAt,
    expiresAt,
    postedAt: null,
  };
  state.byId.set(id, {
    dto,
    destinationAccountNumber: confirmation.destinationAccountNumber,
    destinationMaskedName: confirmation.destinationMaskedName,
    payeeDisplayName: null,
    fingerprint,
  });
  state.byIdempotencyKey.set(params.idempotencyKey, { transferId: id, fingerprint });
  state.recentFingerprints.set(fingerprint, now);
  state.activePendingId = id;
  return { outcome: 'created', transfer: dto };
}

// ---------------------------------------------------------------------------
// Account balance/hold projection — external outbound only. Internal transfers never touch this;
// the fixed fixtures ARE the internal baseline. A hold at initiate raises `held`; settle at confirm
// lowers both `balance` and `held`; release at cancel/expiry lowers `held`. All bigint minor units.
// ---------------------------------------------------------------------------

function adjustmentFor(accountId: string): AccountAdjustment {
  return state.accountAdjustments.get(accountId) ?? { heldDelta: 0n, balanceDelta: 0n };
}

function applyAdjustment(accountId: string, heldDelta: bigint, balanceDelta: bigint): void {
  const current = adjustmentFor(accountId);
  state.accountAdjustments.set(accountId, {
    heldDelta: current.heldDelta + heldDelta,
    balanceDelta: current.balanceDelta + balanceDelta,
  });
}

/** The source account's CURRENT projected `available` (= balance − held) including any live external
 * holds — the figure the funds check compares an outbound amount against. */
function projectedAvailable(accountId: string): bigint {
  const base = fixtureAccounts.find((account) => account.id === accountId);
  if (!base) {
    return 0n;
  }
  const adjustment = adjustmentFor(accountId);
  return (
    BigInt(base.balance) + adjustment.balanceDelta - (BigInt(base.held) + adjustment.heldDelta)
  );
}

/** Release an external outbound's PLACED hold (cancel / expiry / supersede): `held -= amount`, with
 * NO balance change. Idempotent — only a PLACED hold is released. A no-op for internal transfers. */
function releaseHoldIfPlaced(stored: StoredTransfer): void {
  if (
    stored.dto.type === 'external_outbound' &&
    stored.holdState === 'PLACED' &&
    stored.dto.sourceAccountId
  ) {
    applyAdjustment(stored.dto.sourceAccountId, -BigInt(stored.dto.amount), 0n);
    stored.holdState = 'RELEASED';
  }
}

/** Settle an external outbound's PLACED hold on confirm: the reservation becomes a posted movement,
 * so `balance -= amount` AND `held -= amount` (net `available` returns to balance − amount).
 * Idempotent — only a PLACED hold is settled. A no-op for internal transfers. */
function settleHoldIfPlaced(stored: StoredTransfer): void {
  if (
    stored.dto.type === 'external_outbound' &&
    stored.holdState === 'PLACED' &&
    stored.dto.sourceAccountId
  ) {
    const amount = BigInt(stored.dto.amount);
    applyAdjustment(stored.dto.sourceAccountId, -amount, -amount);
    stored.holdState = 'SETTLED';
  }
}

/** The caller's accounts with external-hold deltas folded over the fixtures. With no external
 * activity (or right after a reset) this returns values byte-identical to `fixtureAccounts`, so
 * internal-only tests are unaffected. Whitelists each field — never leaks a non-DTO column. */
export function projectAccounts(): AccountDto[] {
  return fixtureAccounts.map((base) => {
    const adjustment = adjustmentFor(base.id);
    const balance = BigInt(base.balance) + adjustment.balanceDelta;
    const held = BigInt(base.held) + adjustment.heldDelta;
    const available = balance - held;
    return {
      id: base.id,
      currency: base.currency,
      status: base.status,
      kind: base.kind,
      balance: balance.toString(),
      held: held.toString(),
      available: available.toString(),
      accountNumber: base.accountNumber,
      // Carry the seeded account's label through the whitelist (else it would be silently dropped).
      label: base.label ?? null,
    };
  });
}

export type ExternalInitiateResult =
  | { outcome: 'created' | 'replayed'; transfer: TransferDto }
  | { outcome: 'duplicate' }
  | { outcome: 'key-reused' }
  | { outcome: 'insufficient-funds' };

/**
 * Initiate a PENDING external-outbound transfer to an ENROLLED payee (addressed by `payeeId`),
 * mirroring the service's idempotency + soft-duplicate + single-pending semantics AND the hold:
 * under the same key a matching fingerprint replays, a different one is key reuse; an identical
 * recent payment is soft-blocked unless `confirmDuplicate`; a new initiate supersedes the prior
 * pending (releasing an external prior's hold first). Then it checks funds against the source's
 * projected `available` (post-release) and PLACES A HOLD (`held += amount`) — no balance moves. The
 * payee's existence + cooling-off are checked by the caller (handler) before this runs; the
 * fingerprint uses `payeeId` (not an account number) exactly like the service's `computeFingerprint`.
 */
export function initiateExternalTransfer(params: {
  idempotencyKey: string;
  sourceAccountId: string;
  payeeId: string;
  payeeDisplayName: string;
  amount: string;
  currency: string;
  confirmDuplicate: boolean;
}): ExternalInitiateResult {
  // The request fingerprint mirrors the service's `computeFingerprint` tuple (type, source,
  // destination=payeeId, amount, currency) — distinct from an internal fingerprint (which uses the
  // destination account NUMBER), so the two key spaces never collide. Excludes `confirmDuplicate`.
  const fingerprint = `external_outbound|${params.sourceAccountId}|${params.payeeId}|${params.amount}|${params.currency}`;

  // 1. Existing idempotency key → replay the original on a fingerprint MATCH, else key reuse (409).
  const existing = state.byIdempotencyKey.get(params.idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return { outcome: 'key-reused' };
    }
    const stored = state.byId.get(existing.transferId);
    if (stored) {
      applyLazyExpiry(stored);
      return { outcome: 'replayed', transfer: stored.dto };
    }
  }

  // 2. Soft duplicate: an identical payment within the window under a DIFFERENT key needs an
  //    explicit confirmDuplicate. Returns BEFORE claiming the key (so "Send anyway" is a clean create).
  const now = Date.now();
  const lastAt = state.recentFingerprints.get(fingerprint);
  if (!params.confirmDuplicate && lastAt !== undefined && now - lastAt < DUPLICATE_WINDOW_MS) {
    return { outcome: 'duplicate' };
  }

  // 3. Funds check. Account for releasing the prior external pending's hold on the SAME source
  //    (superseding it frees that reservation), so the check matches the post-supersede money state.
  let releasableFromPrior = 0n;
  if (state.activePendingId) {
    const prior = state.byId.get(state.activePendingId);
    if (prior) {
      applyLazyExpiry(prior);
      if (
        prior.dto.status === 'PENDING' &&
        prior.dto.type === 'external_outbound' &&
        prior.holdState === 'PLACED' &&
        prior.dto.sourceAccountId === params.sourceAccountId
      ) {
        releasableFromPrior = BigInt(prior.dto.amount);
      }
    }
  }
  if (BigInt(params.amount) > projectedAvailable(params.sourceAccountId) + releasableFromPrior) {
    // No state mutated (mirrors the service's transaction rollback: the key is NOT claimed, so a
    // retry with an adjusted amount under the same key is a fresh attempt, not key reuse).
    return { outcome: 'insufficient-funds' };
  }

  // 4. Single active pending: supersede the prior pending (→ CANCELLED), releasing an external
  //    prior's hold first.
  if (state.activePendingId) {
    const prior = state.byId.get(state.activePendingId);
    if (prior && prior.dto.status === 'PENDING') {
      releaseHoldIfPlaced(prior);
      prior.dto = { ...prior.dto, status: 'CANCELLED' };
    }
  }

  // 5. Place the hold (held += amount) + create the PENDING external_outbound transfer.
  const id = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PENDING_TTL_MS).toISOString();
  const dto: TransferDto = {
    id,
    type: 'external_outbound',
    status: 'PENDING',
    amount: params.amount,
    currency: params.currency,
    sourceAccountId: params.sourceAccountId,
    createdAt,
    expiresAt,
    postedAt: null,
  };
  applyAdjustment(params.sourceAccountId, BigInt(params.amount), 0n);
  state.byId.set(id, {
    dto,
    destinationAccountNumber: null,
    destinationMaskedName: null,
    payeeDisplayName: params.payeeDisplayName,
    fingerprint,
    holdState: 'PLACED',
  });
  state.byIdempotencyKey.set(params.idempotencyKey, { transferId: id, fingerprint });
  state.recentFingerprints.set(fingerprint, now);
  state.activePendingId = id;
  return { outcome: 'created', transfer: dto };
}

export type ConfirmResult =
  | { outcome: 'posted' | 'already-posted'; transfer: TransferDto }
  | { outcome: 'not-found' | 'expired' | 'not-pending' | 'invalid-otp' };

/** Confirm a PENDING transfer with the caller's one-time code — POSTS it (money moves) on the
 * deterministic dev code. Checks expiry BEFORE the code (an expired transfer never validates the
 * code), and is an idempotent replay for an already-POSTED transfer. */
export function confirmTransfer(transferId: string, code: string, devCode: string): ConfirmResult {
  const stored = state.byId.get(transferId);
  if (!stored) {
    return { outcome: 'not-found' };
  }
  applyLazyExpiry(stored);
  if (stored.dto.status === 'POSTED') {
    return { outcome: 'already-posted', transfer: stored.dto };
  }
  if (stored.dto.status === 'EXPIRED') {
    return { outcome: 'expired' };
  }
  if (stored.dto.status !== 'PENDING') {
    return { outcome: 'not-pending' };
  }
  if (code !== devCode) {
    return { outcome: 'invalid-otp' };
  }
  stored.dto = { ...stored.dto, status: 'POSTED', postedAt: new Date().toISOString() };
  // External settle: the hold becomes a posted movement (balance -= amount, held -= amount). A
  // no-op for internal transfers, whose balances the stub deliberately leaves untouched.
  settleHoldIfPlaced(stored);
  if (state.activePendingId === transferId) {
    state.activePendingId = null;
  }
  return { outcome: 'posted', transfer: stored.dto };
}

export type CancelResult =
  | { outcome: 'cancelled' | 'already-terminal'; transfer: TransferDto }
  | { outcome: 'not-found' | 'not-pending' };

/** Cancel a PENDING transfer (guarded PENDING→CANCELLED); idempotent on an already
 * cancelled/expired transfer; a POSTED transfer cannot be cancelled. */
export function cancelTransfer(transferId: string): CancelResult {
  const stored = state.byId.get(transferId);
  if (!stored) {
    return { outcome: 'not-found' };
  }
  applyLazyExpiry(stored);
  if (stored.dto.status === 'POSTED') {
    return { outcome: 'not-pending' };
  }
  if (stored.dto.status === 'CANCELLED' || stored.dto.status === 'EXPIRED') {
    return { outcome: 'already-terminal', transfer: stored.dto };
  }
  if (stored.dto.status !== 'PENDING') {
    return { outcome: 'not-pending' };
  }
  stored.dto = { ...stored.dto, status: 'CANCELLED' };
  // External cancel releases the hold (held -= amount, balance unchanged). A no-op for internal.
  releaseHoldIfPlaced(stored);
  if (state.activePendingId === transferId) {
    state.activePendingId = null;
  }
  return { outcome: 'cancelled', transfer: stored.dto };
}

/** The caller's single active PENDING transfer projected for the feed, or `null`. Reading is a
 * lazy-expiry access point (an overdue pending flips to EXPIRED and returns `null`). */
export function getPendingAuthorization(): PendingAuthorizationDto | null {
  if (!state.activePendingId) {
    return null;
  }
  const stored = state.byId.get(state.activePendingId);
  if (!stored) {
    state.activePendingId = null;
    return null;
  }
  applyLazyExpiry(stored);
  if (stored.dto.status !== 'PENDING') {
    if (state.activePendingId === stored.dto.id) {
      state.activePendingId = null;
    }
    return null;
  }
  return {
    transferId: stored.dto.id,
    type: stored.dto.type,
    amount: stored.dto.amount,
    currency: stored.dto.currency,
    sourceAccountId: stored.dto.sourceAccountId,
    destinationAccountNumber: stored.destinationAccountNumber,
    destinationMaskedName: stored.destinationMaskedName,
    payeeDisplayName: stored.payeeDisplayName,
    createdAt: stored.dto.createdAt,
    expiresAt: stored.dto.expiresAt,
  };
}

/** Flip an overdue PENDING transfer to EXPIRED (the lazy-expiry rule), releasing the active-pending
 * slot. A no-op for any non-PENDING or not-yet-overdue transfer. */
function applyLazyExpiry(stored: StoredTransfer): void {
  if (stored.dto.status !== 'PENDING') {
    return;
  }
  if (stored.dto.expiresAt !== null && Date.now() > Date.parse(stored.dto.expiresAt)) {
    stored.dto = { ...stored.dto, status: 'EXPIRED' };
    // An overdue external pending releases its hold (held -= amount). A no-op for internal.
    releaseHoldIfPlaced(stored);
    if (state.activePendingId === stored.dto.id) {
      state.activePendingId = null;
    }
  }
}
