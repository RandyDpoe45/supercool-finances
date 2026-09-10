/** DI token for {@link IRelayService}. Consumers depend on the interface via this token,
 * never the concrete class. */
export const RELAY_SERVICE = Symbol('RELAY_SERVICE');

/**
 * The outbox relay (spec 04 step 6): an in-process background poll loop inside the balance
 * service (NOT an OS cron, NOT a separate process) that drains the transactional outbox onto
 * the `events:transactions` Redis stream. Every balance-service instance runs the loop;
 * `FOR UPDATE SKIP LOCKED` on the poll means concurrent instances claim disjoint rows and never
 * double-publish.
 */
export interface IRelayService {
  /**
   * Publish ONE batch of unpublished outbox rows and return how many were published this tick.
   * In one transaction: claim up to the configured batch size with `FOR UPDATE SKIP LOCKED`,
   * `XADD` each row to `events:transactions` **before** marking it published (at-least-once — a
   * crash between the XADD and the mark re-publishes a duplicate, never loses; the consumer
   * dedups on `event_id`), then mark the batch published and commit. Returns `0` when the outbox
   * is empty.
   *
   * This is the seam the tests drive directly: two concurrent `drainOnce()` across instances
   * prove SKIP LOCKED (disjoint claims) without racing the timer.
   */
  drainOnce(): Promise<number>;
}
