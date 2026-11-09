/**
 * Token bucket throttle for rate limiting per role.
 * Prevents hammering the gateway with more than `rpm` requests per minute.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rpm: number,
    private readonly maxBurst = 1
  ) {
    this.tokens = maxBurst;
    this.lastRefill = Date.now();
  }

  /** Wait until a token is available, then consume it. */
  async acquire(): Promise<void> {
    if (this.rpm <= 0) return; // no throttle
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Wait for the next token
      const msPerToken = 60_000 / this.rpm;
      await sleep(msPerToken);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / 60_000) * this.rpm;
    this.tokens = Math.min(this.maxBurst, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Manage one bucket per role. */
export class RoleThrottle {
  private readonly buckets = new Map<string, TokenBucket>();

  setRpm(role: string, rpm: number): void {
    if (rpm > 0) {
      this.buckets.set(role, new TokenBucket(rpm, Math.ceil(rpm / 10)));
    } else {
      this.buckets.delete(role);
    }
  }

  async acquire(role: string): Promise<void> {
    const bucket = this.buckets.get(role);
    if (bucket) await bucket.acquire();
  }
}
