/**
 * The source of "now" for token issuance and expiry. Injected so tests can move time
 * forward deterministically (token expiry in the property tests). Ledger booking time
 * is NOT taken from here — it is always the database's `now()` (design §5.3).
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
