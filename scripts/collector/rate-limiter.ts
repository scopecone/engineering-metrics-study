export class RateLimiter {
  private remaining = 5000;
  private resetAt = new Date(Date.now() + 60_000);
  private threshold: number;

  constructor(threshold: number = 100) {
    this.threshold = threshold;
  }

  async checkAndWait() {
    const now = Date.now();
    if (this.remaining > this.threshold || this.resetAt.getTime() <= now) {
      return;
    }
    const waitMs = this.resetAt.getTime() - now + 1000;
    const seconds = Math.ceil(waitMs / 1000);
    console.log(`⏸️  Rate limit low (${this.remaining} remaining). Waiting ${seconds}s until ${this.resetAt.toISOString()}…`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  updateFromHeaders(headers: Record<string, string | number | undefined>) {
    const remainingHeader = headers["x-ratelimit-remaining"];
    const resetHeader = headers["x-ratelimit-reset"];
    if (typeof remainingHeader === "string") {
      const parsed = Number.parseInt(remainingHeader, 10);
      if (!Number.isNaN(parsed)) {
        this.remaining = parsed;
      }
    } else if (typeof remainingHeader === "number") {
      this.remaining = remainingHeader;
    }

    if (typeof resetHeader === "string") {
      const parsed = Number.parseInt(resetHeader, 10);
      if (!Number.isNaN(parsed)) {
        this.resetAt = new Date(parsed * 1000);
      }
    } else if (typeof resetHeader === "number") {
      this.resetAt = new Date(resetHeader * 1000);
    }
  }
}
