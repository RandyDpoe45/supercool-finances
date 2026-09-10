import type { PendingAuthorizationDto, TransferDto } from '../../services/api/contracts/transfers';
import { fixtureDestinations } from '../fixtures/destinations';

/**
 * In-memory transfer state for the MSW stub, mirroring the balance-service transfer lifecycle
 * closely enough to exercise the client flow end to end WITHOUT a backend: confirmation-of-payee
 * tokens, idempotent initiate (same key + same money tuple → the SAME transfer; same key + a
 * DIFFERENT tuple → key reuse, mirroring the service's `IdempotencyKeyReuseError` → 409), the
 * 60-second soft-duplicate window
 * (honoring `confirmDuplicate`), the single-active-pending rule (a new initiate auto-supersedes the
 * prior pending), the 2-minute pending deadline (lazy expiry), and OTP-gated confirm / cancel.
 *
 * State lives at module scope (the worker + the node test server each get their own instance).
 * `resetTransferStore()` clears it so a test can start from a clean slate. NO balances are mutated
 * here — the stub intentionally serves the fixed accounts fixtures, so the load-bearing proof stays
 * the client's cache invalidation / refetch, not a simulated balance change (which would make the
 * accounts fixtures order-dependent across tests).
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

interface StoredTransfer {
  dto: TransferDto;
  destinationAccountNumber: string;
  destinationMaskedName: string;
  fingerprint: string;
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
}

function freshState(): TransferStoreState {
  return {
    tokens: new Map(),
    byId: new Map(),
    byIdempotencyKey: new Map(),
    recentFingerprints: new Map(),
    activePendingId: null,
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
    fingerprint,
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
    payeeDisplayName: null,
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
    if (state.activePendingId === stored.dto.id) {
      state.activePendingId = null;
    }
  }
}
