/** DI token for {@link IStreamConsumerService}. Consumers depend on the interface,
 *  never the concrete class (ADR: depend on interfaces/tokens). */
export const STREAM_CONSUMER_SERVICE = Symbol('STREAM_CONSUMER_SERVICE');

/** Optional knobs for a single {@link IStreamConsumerService.consumeOnce} pass. */
export interface ConsumeOnceOptions {
  /** Min idle time (ms) an un-acked pending entry must have before this pass reclaims
   *  it via `XAUTOCLAIM`. Tests pass `0` to reclaim immediately; the live loop uses the
   *  code-constant default. */
  claimMinIdleMs?: number;
}

/**
 * The transaction-stream consumer (spec 05, step A2) — the read-model BL. Reads the
 * `events:transactions` Redis stream via a consumer group, projects each event into
 * the `transactions` read model, and acks WRITE-THEN-ACK so at-least-once redelivery
 * is safe (idempotent upsert by `_id = event_id` → exactly-once effect).
 */
export interface IStreamConsumerService {
  /**
   * Create the consumer group if absent (`XGROUP CREATE … $ MKSTREAM`, `BUSYGROUP`
   * swallowed as a no-op). Idempotent — safe to call repeatedly; run once on bootstrap
   * before the loop starts.
   */
  ensureGroup(): Promise<void>;

  /**
   * Process ONE batch — first reclaimed idle-pending entries (`XAUTOCLAIM`, the crash
   * recovery), then new entries (`XREADGROUP '>'`, non-blocking) — and return the count
   * successfully processed (projected + upserted + acked). Malformed entries are logged
   * and left unacked (not counted). The test seam; the live loop uses a blocking read.
   */
  consumeOnce(options?: ConsumeOnceOptions): Promise<number>;
}
