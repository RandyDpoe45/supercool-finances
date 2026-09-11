import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../../../../config/config.tokens';
import { AppConfig } from '../../../../config/configuration';
import {
  ITransactionsRepository,
  TRANSACTIONS_REPOSITORY,
  TransactionReadModel,
} from '../../../../database/repositories/interfaces/transactions.repository.interface';
import { REDIS_CLIENT } from '../../../../redis/redis.tokens';
import {
  ConsumeOnceOptions,
  IStreamConsumerService,
} from '../interfaces/stream-consumer.service.interface';
import { projectEvent } from './project-event';

/** The Redis stream every transaction event is published to (balance↔analytics contract of
 *  record; the analytics server keeps its OWN copy — ADR-16). Fixed literal, per spec 04/05. */
export const TRANSACTION_STREAM_KEY = 'events:transactions';
/** The consumer group name. All analytics-server instances share this ONE group, so each event
 *  is delivered to exactly one instance (competing consumers). */
export const CONSUMER_GROUP = 'analytics';
/** A STABLE consumer name (not per-boot): a crashed consumer's un-acked PEL entries survive a
 *  restart under the same name and are reclaimable by `XAUTOCLAIM` — the restart-recovery path. */
export const CONSUMER_NAME = 'analytics-consumer';
/** Max entries claimed/read per pass (both `XAUTOCLAIM` and `XREADGROUP`). */
export const READ_COUNT = 100;
/** Blocking-read wait (ms) in the live loop, so an idle stream is not busy-polled. */
export const BLOCK_MS = 5000;
/** Default min idle time (ms) before a pending entry is reclaimable (a crashed consumer's
 *  entries are recovered only once they have gone this long without an ack). */
export const CLAIM_MIN_IDLE_MS = 60000;

/** (entryId, raw fields) for one stream entry. `entryId` is the STREAM id used for `XACK`
 *  (distinct from the `event_id` field inside, which is the read-model `_id`). */
interface StreamEntry {
  id: string;
  fields: unknown;
}

/**
 * The transaction-stream consumer (spec 05, step A2) — the read-model BL. An in-process loop
 * over the `events:transactions` Redis consumer group. Mirrors the balance service's outbox
 * relay loop (self-rescheduling `setTimeout`, `stopped`/`timer`/`activeTick`, error-swallowing,
 * a `consumeOnce` test seam) but runs the CONSUME direction.
 *
 * Money safety — WRITE-THEN-ACK + idempotent upsert:
 *   `XREADGROUP '>'` → project → `upsertByEventId` → **then** `XACK`. A crash between the upsert
 *   and the ack leaves the entry pending; it is later reclaimed (`XAUTOCLAIM`) and re-upserted,
 *   and because the upsert is keyed on `_id = event_id` the effect is exactly-once (one document)
 *   over an at-least-once stream. We NEVER ack before the upsert succeeds, and NEVER drop a
 *   malformed entry (it is left pending for reclaim/inspection — a bad event is never lost).
 *
 * Shutdown uses `OnModuleDestroy` (fires on `app.close()` without `enableShutdownHooks()`), the
 * same reasoning as the relay, so the loop is reliably stopped on teardown.
 */
@Injectable()
export class StreamConsumerService
  implements IStreamConsumerService, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StreamConsumerService.name);

  /** Set on shutdown; once true no further tick is ever scheduled. */
  private stopped = false;
  /** Handle of the pending next-tick timer, or null when none is scheduled. */
  private timer: NodeJS.Timeout | null = null;
  /** The in-flight tick promise, or null between ticks. Awaited on shutdown so a running pass
   *  finishes cleanly. `runTick` never rejects, so awaiting is safe. */
  private activeTick: Promise<void> | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(TRANSACTIONS_REPOSITORY) private readonly transactions: ITransactionsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Gate ALL Redis interaction (group creation included) behind the enabled flag, like the
    // balance service's relay. When disabled, we issue NO command, so the lazy-connect client
    // never dials Redis — booting AppModule without Redis (unit/e2e/Mongo-only tests, which set
    // ANALYTICS_CONSUMER_ENABLED=false) neither hangs nor throws. `ensureGroup()` stays a public,
    // idempotent seam the integration suite calls directly. When enabled (production, Redis up
    // via depends_on), the group is created BEFORE the loop's first XREADGROUP.
    if (!this.config.consumer.enabled) {
      this.logger.log(
        'Transaction-stream consumer disabled (ANALYTICS_CONSUMER_ENABLED=false) — group not created, loop not started.',
      );
      return;
    }
    await this.ensureGroup();
    this.logger.log(
      `Transaction-stream consumer loop started (group=${CONSUMER_GROUP}, consumer=${CONSUMER_NAME}, ` +
        `blockMs=${BLOCK_MS}, count=${READ_COUNT}).`,
    );
    this.scheduleNext(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish (its blocking read can be waiting up to BLOCK_MS).
    if (this.activeTick !== null) {
      await this.activeTick;
    }
  }

  async ensureGroup(): Promise<void> {
    try {
      // '$' = only deliver entries added AFTER the group is created (no historical replay);
      // MKSTREAM creates the stream if the producer has not yet XADDed to it.
      await this.redis.xgroup('CREATE', TRANSACTION_STREAM_KEY, CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // BUSYGROUP: the group already exists — a no-op, the expected steady-state path.
      if (message.includes('BUSYGROUP')) {
        return;
      }
      throw error;
    }
  }

  async consumeOnce(options?: ConsumeOnceOptions): Promise<number> {
    const minIdle = options?.claimMinIdleMs ?? CLAIM_MIN_IDLE_MS;
    // Recovery FIRST: reclaim idle un-acked entries (a crashed consumer's PEL), then read new.
    const reclaimed = await this.reclaimIdle(minIdle);
    const fresh = await this.readNew(null);
    return reclaimed + fresh;
  }

  /** Reclaim + process idle-pending entries via `XAUTOCLAIM` (starting from PEL head, `0`).
   *  Returns the count successfully processed (upserted + acked). */
  private async reclaimIdle(minIdleMs: number): Promise<number> {
    const reply = await this.redis.xautoclaim(
      TRANSACTION_STREAM_KEY,
      CONSUMER_GROUP,
      CONSUMER_NAME,
      minIdleMs,
      '0',
      'COUNT',
      READ_COUNT,
    );
    return this.processEntries(this.extractClaimEntries(reply));
  }

  /** Read + process new (never-delivered) entries via `XREADGROUP '>'`. `blockMs` null = the
   *  non-blocking `consumeOnce` seam; a number = the live loop's blocking wait. */
  private async readNew(blockMs: number | null): Promise<number> {
    const reply =
      blockMs === null
        ? await this.redis.xreadgroup(
            'GROUP',
            CONSUMER_GROUP,
            CONSUMER_NAME,
            'COUNT',
            READ_COUNT,
            'STREAMS',
            TRANSACTION_STREAM_KEY,
            '>',
          )
        : await this.redis.xreadgroup(
            'GROUP',
            CONSUMER_GROUP,
            CONSUMER_NAME,
            'COUNT',
            READ_COUNT,
            'BLOCK',
            blockMs,
            'STREAMS',
            TRANSACTION_STREAM_KEY,
            '>',
          );
    return this.processEntries(this.extractReadEntries(reply));
  }

  /** Process a batch sequentially; return the count acked. A malformed entry is logged + skipped
   *  (left pending); an infra error (e.g. the upsert throwing) propagates to fail the pass. */
  private async processEntries(entries: StreamEntry[]): Promise<number> {
    let processed = 0;
    for (const entry of entries) {
      if (await this.processEntry(entry)) {
        processed += 1;
      }
    }
    return processed;
  }

  /**
   * Project → upsert → XACK for ONE entry (write-then-ack). Returns true when acked.
   * A MALFORMED entry (bad JSON / missing field / bad money-date) is logged and left UNACKED
   * (returns false) — never dropped, never crashes the batch. An UPSERT failure is NOT caught
   * here: it propagates so the entry stays pending and the pass backs off (transient infra, not
   * a poison pill).
   */
  private async processEntry(entry: StreamEntry): Promise<boolean> {
    let doc: TransactionReadModel;
    try {
      const record = this.fieldsToRecord(entry.fields);
      const eventId = record['event_id'];
      const eventType = record['event_type'];
      const payload = record['payload'];
      if (!eventId || !eventType || payload === undefined) {
        throw new Error('missing one of the stream fields event_id/event_type/payload');
      }
      doc = projectEvent(eventId, eventType, payload);
    } catch (error) {
      this.logger.error(
        `Malformed stream entry (streamId=${entry.id}, event_id=${this.safeEventId(entry.fields)}) ` +
          `left UNACKED for reclaim/inspection: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    // Write-then-ack: the upsert MUST succeed before we ack. A throw here leaves the entry pending.
    await this.transactions.upsertByEventId(doc);
    await this.redis.xack(TRANSACTION_STREAM_KEY, CONSUMER_GROUP, entry.id);
    return true;
  }

  /** Schedule the next tick `delayMs` from now — unless stopped. Guarded again in the callback
   *  for the race where shutdown lands after the timer is set but before it fires. */
  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) {
        return;
      }
      this.activeTick = this.runTick();
    }, delayMs);
  }

  /** One loop tick: reclaim idle-pending, then a BLOCKING read of new entries. On success reschedule
   *  immediately (the block already paced an idle stream, and a backlog drains fast); on a Redis/infra
   *  error, log + back off by BLOCK_MS so a persistent failure never becomes a hot error loop. */
  private async runTick(): Promise<void> {
    let errored = false;
    try {
      await this.reclaimIdle(CLAIM_MIN_IDLE_MS);
      await this.readNew(BLOCK_MS);
    } catch (error) {
      errored = true;
      this.logger.error(
        `Transaction-stream consumer tick failed (will retry): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.activeTick = null;
    }
    this.scheduleNext(errored ? BLOCK_MS : 0);
  }

  /** XAUTOCLAIM reply: `[nextCursor, [[id, fields], ...], [deletedIds]]`. Entries at index 1. */
  private extractClaimEntries(reply: unknown): StreamEntry[] {
    if (!Array.isArray(reply) || reply.length < 2) {
      return [];
    }
    return this.toEntries(reply[1]);
  }

  /** XREADGROUP reply: `[[streamKey, [[id, fields], ...]], ...]` or null (nothing / block timeout). */
  private extractReadEntries(reply: unknown): StreamEntry[] {
    if (!Array.isArray(reply)) {
      return [];
    }
    const entries: StreamEntry[] = [];
    for (const stream of reply) {
      if (Array.isArray(stream) && stream.length >= 2) {
        entries.push(...this.toEntries(stream[1]));
      }
    }
    return entries;
  }

  /** Normalize a `[[id, fields], ...]` list into {@link StreamEntry}s, skipping shapes without a
   *  string id. An `[id, null]` tombstone (its stream item was trimmed) is passed through with
   *  `fields: null` and then treated as malformed downstream (logged, left unacked) — but in
   *  practice XAUTOCLAIM (Redis 7+) auto-evicts trimmed entries into its separate "deleted" reply
   *  slot, so this consumer effectively never sees one. */
  private toEntries(raw: unknown): StreamEntry[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const entries: StreamEntry[] = [];
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string') {
        entries.push({ id: entry[0], fields: entry[1] });
      }
    }
    return entries;
  }

  /** Flat `[field, value, field, value, ...]` (ioredis returns utf8 strings) → a record. */
  private fieldsToRecord(fields: unknown): Record<string, string> {
    if (!Array.isArray(fields)) {
      throw new Error('stream entry fields are not an array');
    }
    const record: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (typeof key === 'string' && typeof value === 'string') {
        record[key] = value;
      }
    }
    return record;
  }

  /** Best-effort event_id for a malformed-entry log line (never throws). */
  private safeEventId(fields: unknown): string {
    try {
      return this.fieldsToRecord(fields)['event_id'] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
