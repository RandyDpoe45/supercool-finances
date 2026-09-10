import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../../../../config/config.tokens';
import { AppConfig } from '../../../../config/configuration';
import {
  IOutboxEventRepository,
  OUTBOX_EVENT_REPOSITORY,
} from '../../../../database/repositories/interfaces/outbox-event.repository.interface';
import { REDIS_CLIENT } from '../../../../redis/redis.tokens';
import { IRelayService } from '../interfaces/relay.service.interface';

/** The Redis stream every transaction event is published to (balance↔analytics contract of
 * record; the analytics server keeps its own copy). Fixed literal, per spec 04. */
export const TRANSACTION_STREAM_KEY = 'events:transactions';

/**
 * The outbox relay worker (spec 04 step 6) — an in-process poll loop that drains the
 * transactional outbox onto the {@link TRANSACTION_STREAM_KEY} Redis stream.
 *
 * Reuses the injected, lifecycle-managed {@link REDIS_CLIENT} and the default `DataSource`
 * (never its own client/pool). Each tick opens ONE READ COMMITTED transaction, claims
 * unpublished rows `FOR UPDATE SKIP LOCKED` (so multiple balance-service instances never
 * double-publish), `XADD`s each row **before** marking it published (at-least-once), then
 * commits.
 *
 * The loop is a self-rescheduling `setTimeout` chain (NOT a fixed `setInterval`), so ticks
 * never overlap and a full batch reschedules immediately to drain a backlog fast. Every tick is
 * wrapped so a rejected XADD (Redis down) or a DB error is logged and swallowed — it must never
 * crash the loop or the process; the unpublished rows simply republish next tick.
 *
 * Shutdown uses `OnModuleDestroy` rather than `OnApplicationShutdown`: `main.ts` does not call
 * `app.enableShutdownHooks()`, and `onModuleDestroy` fires on `app.close()` (which the tests
 * use) without it — so the loop is reliably stopped on teardown.
 */
@Injectable()
export class RelayService implements IRelayService, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RelayService.name);

  /** Set on shutdown; once true no further tick is ever scheduled. */
  private stopped = false;
  /** Handle of the pending next-tick timer, or null when none is scheduled. */
  private timer: NodeJS.Timeout | null = null;
  /** The in-flight tick promise, or null between ticks. Awaited on shutdown so a running drain
   *  finishes (never abandons an open transaction). `runTick` never rejects, so awaiting is safe. */
  private activeTick: Promise<void> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OUTBOX_EVENT_REPOSITORY) private readonly outbox: IOutboxEventRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.relay.enabled) {
      this.logger.log('Outbox relay disabled (RELAY_ENABLED=false) — poll loop not started.');
      return;
    }
    this.logger.log(
      `Outbox relay poll loop started (pollIntervalMs=${this.config.relay.pollIntervalMs}, ` +
        `batchSize=${this.config.relay.batchSize}).`,
    );
    this.scheduleNext(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish so we never abandon its open transaction mid-drain.
    if (this.activeTick !== null) {
      await this.activeTick;
    }
  }

  async drainOnce(): Promise<number> {
    // Plain READ COMMITTED tx (no deadlock-retry wrapper: SKIP LOCKED skips locked rows rather
    // than waiting, so a claim never deadlocks). If any XADD throws, the whole tick's tx rolls
    // back — nothing is marked published — so the batch republishes next tick (at-least-once).
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');
    try {
      const rows = await this.outbox.pollUnpublished(queryRunner, this.config.relay.batchSize);
      if (rows.length === 0) {
        await queryRunner.commitTransaction();
        return 0;
      }
      // XADD each row (in claim order) BEFORE marking it published. The stream entry contract is
      // exactly three fields — event_id (the OutboxEvent.id, the consumer's dedup key), event_type,
      // and payload (the reducer's JSON, stringified since `payload` is a jsonb object). Never
      // mark-then-XADD: a crash there would lose the event.
      for (const row of rows) {
        await this.redis.xadd(
          TRANSACTION_STREAM_KEY,
          '*',
          'event_id',
          row.id,
          'event_type',
          row.eventType,
          'payload',
          JSON.stringify(row.payload),
        );
      }
      await this.outbox.markPublished(
        queryRunner,
        rows.map((row) => row.id),
      );
      await queryRunner.commitTransaction();
      return rows.length;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /** Schedule the next tick `delayMs` from now — unless already stopped (never schedule after
   *  shutdown). Guarded again inside the callback for the race where shutdown lands after the
   *  timer is set but before it fires. */
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

  /** One tick: drain a batch, then reschedule. A full batch reschedules immediately (0ms) to
   *  drain a backlog fast; otherwise after the poll interval. Errors are swallowed so a Redis/DB
   *  failure degrades this tick, never the loop or the process. */
  private async runTick(): Promise<void> {
    let published = 0;
    try {
      published = await this.drainOnce();
    } catch (error) {
      this.logger.error(
        `Outbox relay drain tick failed (will retry next tick): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.activeTick = null;
    }
    const nextDelay =
      published >= this.config.relay.batchSize ? 0 : this.config.relay.pollIntervalMs;
    this.scheduleNext(nextDelay);
  }
}
