import type { Rng } from './rng.js';

// Monotonic UUIDv7 (RFC 9562, method 1: a 12-bit counter in `rand_a`), the
// same rule as the plugin: IDs made in the order things happen are strictly
// increasing, also within one millisecond. See
// docs/architecture.md#raw-events-and-projections.

const MAX_COUNTER = 0xfff;
/** A new millisecond starts the counter at most here, leaving room to count up. */
const MAX_START = 0x7ff;
const MAX_UNIX_MS = 2 ** 48 - 1;

export class MonotonicUuidV7 {
  private lastMs = -1;
  private counter = 0;

  constructor(private readonly rng: Rng) {}

  /** A new ID for an event at `ms` (Unix milliseconds). `ms` must never go backwards. */
  next(ms: number): string {
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_UNIX_MS) {
      throw new RangeError(`Not a valid UUIDv7 timestamp: ${String(ms)}`);
    }
    if (ms < this.lastMs) {
      throw new RangeError(`Time went backwards: ${String(ms)} < ${String(this.lastMs)}`);
    }
    if (ms === this.lastMs) {
      this.counter += 1;
      if (this.counter > MAX_COUNTER) {
        throw new RangeError('Too many IDs in one millisecond');
      }
    } else {
      this.lastMs = ms;
      this.counter = this.rng.int(0, MAX_START);
    }

    const time = ms.toString(16).padStart(12, '0');
    const randA = this.counter.toString(16).padStart(3, '0');
    const variant = (0x8 | this.rng.int(0, 3)).toString(16);
    let randB = '';
    for (let i = 0; i < 15; i++) randB += this.rng.int(0, 15).toString(16);
    return `${time.slice(0, 8)}-${time.slice(8)}-7${randA}-${variant}${randB.slice(0, 3)}-${randB.slice(3)}`;
  }
}
