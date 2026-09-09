/**
 * Domain enumerations, mapped to NATIVE Postgres enum types (see the CreateBalanceCore
 * migration). Each TypeScript member's string value must match the native type's label
 * exactly — the DB type is the source of truth and is created/dropped by the migration,
 * never by TypeORM synchronize. The `enumName` on each column binds to these native types.
 */

export enum AccountKind {
  Customer = 'customer',
  System = 'system',
}

export enum AccountStatus {
  Active = 'active',
  Frozen = 'frozen',
}

export enum TransactionType {
  Internal = 'internal',
  ExternalOutbound = 'external_outbound',
  ExternalInbound = 'external_inbound',
}

export enum TransactionStatus {
  Pending = 'PENDING',
  Posted = 'POSTED',
  Failed = 'FAILED',
  Reversed = 'REVERSED',
}

export enum PayeeStatus {
  Pending = 'pending',
  Active = 'active',
  Disabled = 'disabled',
}
