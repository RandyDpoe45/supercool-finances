import {
  TransactionLegReadModel,
  TransactionPayeeReadModel,
  TransactionReadModel,
} from '../../../../database/repositories/interfaces/transactions.repository.interface';

/**
 * The consumer's OWN copy of the transaction-event payload contract (ADR-16: the
 * analytics server never imports balance-service; the wire shape is duplicated and
 * kept in sync via specs/DATA-MODEL.md Part 2, the contract of record).
 *
 * The wire is **camelCase** (verified against the producer/relay; the snake_case
 * block in analytics-schema.yaml is stale). Money — `amount`, leg `delta` /
 * `balanceAfter` — is an int64 carried as a **string** and parsed to `bigint` here.
 * The three STREAM fields (`event_id`, `event_type`, `payload`) sit OUTSIDE this
 * object; `payload` is the JSON string parsed into it.
 */
export interface TransactionEventPayeeShape {
  id: string;
  displayName: string;
  rail: string;
}

export interface TransactionEventLegShape {
  accountId: string;
  ownerId: string | null;
  accountKind: string;
  systemKey: string | null;
  delta: string;
  balanceAfter: string;
  currency: string;
}

export interface TransactionEventTransactionShape {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  initiatedBy: string;
  reversesTransactionId: string | null;
  payee: TransactionEventPayeeShape | null;
  createdAt: string;
  postedAt: string | null;
  failureReason: string | null;
}

export interface TransactionEventPayload {
  schemaVersion: number;
  occurredAt: string;
  transaction: TransactionEventTransactionShape;
  legs: TransactionEventLegShape[];
}

/** Thrown when a stream entry cannot be projected (bad JSON, missing/typed-wrong
 *  field, unparseable money/date). The consumer treats it as a poison pill: it logs
 *  and leaves the entry UNACKED for reclaim/inspection — never silently dropped. */
export class MalformedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedEventError';
  }
}

/**
 * Pure projection: three stream fields (`event_id`, `event_type`, the `payload` JSON
 * string) → the `transactions` read-model document. No Redis, no Mongo — unit-testable
 * in isolation. Fails loudly (throws {@link MalformedEventError}) on any shape defect
 * so the caller leaves the entry unacked; money strings are parsed to `bigint` verbatim.
 */
export function projectEvent(
  eventId: string,
  eventType: string,
  payloadJson: string,
): TransactionReadModel {
  const raw = parseJson(payloadJson);
  const payload = asObject(raw, 'payload');
  const t = asObject(payload.transaction, 'payload.transaction');
  const legsRaw = asArray(payload.legs, 'payload.legs');

  const legs = legsRaw.map((leg, i) => projectLeg(leg, i));

  return {
    _id: eventId,
    transactionId: requireString(t.id, 'transaction.id'),
    eventType,
    type: requireString(t.type, 'transaction.type'),
    status: requireString(t.status, 'transaction.status'),
    amount: parseMoney(t.amount, 'transaction.amount'),
    currency: requireString(t.currency, 'transaction.currency'),
    initiatedBy: requireString(t.initiatedBy, 'transaction.initiatedBy'),
    reversesTransactionId: nullableString(
      t.reversesTransactionId,
      'transaction.reversesTransactionId',
    ),
    failureReason: nullableString(t.failureReason, 'transaction.failureReason'),
    payee: projectPayee(t.payee),
    legs,
    owners: distinctOwners(legs),
    occurredAt: parseDate(payload.occurredAt, 'payload.occurredAt'),
  };
}

function projectLeg(raw: unknown, index: number): TransactionLegReadModel {
  const leg = asObject(raw, `legs[${index}]`);
  return {
    accountId: requireString(leg.accountId, `legs[${index}].accountId`),
    ownerId: nullableString(leg.ownerId, `legs[${index}].ownerId`),
    accountKind: requireString(leg.accountKind, `legs[${index}].accountKind`),
    systemKey: nullableString(leg.systemKey, `legs[${index}].systemKey`),
    delta: parseMoney(leg.delta, `legs[${index}].delta`),
    balanceAfter: parseMoney(leg.balanceAfter, `legs[${index}].balanceAfter`),
    currency: requireString(leg.currency, `legs[${index}].currency`),
  };
}

function projectPayee(raw: unknown): TransactionPayeeReadModel | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const payee = asObject(raw, 'transaction.payee');
  return {
    id: requireString(payee.id, 'transaction.payee.id'),
    displayName: requireString(payee.displayName, 'transaction.payee.displayName'),
    rail: requireString(payee.rail, 'transaction.payee.rail'),
  };
}

/** Distinct, non-null customer owner ids across the legs (order-preserving) — the
 *  per-customer filter/index helper the read model stores. */
function distinctOwners(legs: TransactionLegReadModel[]): string[] {
  const seen = new Set<string>();
  const owners: string[] = [];
  for (const leg of legs) {
    if (leg.ownerId !== null && !seen.has(leg.ownerId)) {
      seen.add(leg.ownerId);
      owners.push(leg.ownerId);
    }
  }
  return owners;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new MalformedEventError(
      `payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedEventError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new MalformedEventError(`${path} must be an array`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedEventError(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new MalformedEventError(`${path} must be a string or null`);
  }
  return value;
}

/** Parse an int64 minor-units money string to `bigint`. `BigInt()` throws on a
 *  non-integer / non-numeric string, which is the loud failure we want. */
function parseMoney(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedEventError(`${path} must be an int64 string`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new MalformedEventError(`${path} is not a valid int64 string: ${value}`);
  }
}

function parseDate(value: unknown, path: string): Date {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedEventError(`${path} must be an ISO-8601 string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MalformedEventError(`${path} is not a valid date: ${value}`);
  }
  return date;
}
