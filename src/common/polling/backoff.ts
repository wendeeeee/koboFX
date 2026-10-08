/**
 * Backoff arithmetic shared by every durable retry loop (outbox, flows, webhooks) and
 * by the PSP client. Pure: randomness is injected so tests are reproducible.
 */

/** Exponential backoff after the n-th failed attempt: base, 2·base, 4·base … capped. */
export function exponentialBackoffSeconds(attempts: number, baseSeconds: number, maximumSeconds: number): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 30);
  return Math.min(baseSeconds * 2 ** exponent, maximumSeconds);
}

/** A source of uniform randomness in [0, 1). `Math.random` in production. */
export type RandomSource = () => number;

/**
 * "Full jitter" (design §7.2): a uniformly random delay in [0, min(cap, base·2^retry)).
 * Spreads retries from many clients so they don't arrive in synchronised waves.
 */
export function fullJitterDelayMilliseconds(
  retry: number,
  baseMilliseconds: number,
  capMilliseconds: number,
  random: RandomSource,
): number {
  const ceiling = Math.min(capMilliseconds, baseMilliseconds * 2 ** Math.min(Math.max(0, retry), 30));
  return Math.floor(random() * ceiling);
}
