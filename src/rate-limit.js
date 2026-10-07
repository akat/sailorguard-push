'use strict'

// In-memory token buckets (the gateway runs as a single instance).
class RateLimiter {
  /**
   * @param {number} capacity  burst size
   * @param {number} refillPerMinute
   */
  constructor(capacity, refillPerMinute, now = Date.now) {
    this.capacity = capacity
    this.ratePerMs = refillPerMinute / 60000
    this.now = now
    this.buckets = new Map()
  }

  /** @returns {number} 0 if allowed, otherwise seconds until the next token */
  take(key) {
    const t = this.now()
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.capacity, at: t }
      this.buckets.set(key, b)
    }
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.at) * this.ratePerMs)
    b.at = t
    if (b.tokens >= 1) {
      b.tokens -= 1
      return 0
    }
    return Math.ceil((1 - b.tokens) / this.ratePerMs / 1000)
  }

  /** Drop full buckets so the map does not grow forever. */
  sweep() {
    const t = this.now()
    for (const [key, b] of this.buckets) {
      if (b.tokens + (t - b.at) * this.ratePerMs >= this.capacity) this.buckets.delete(key)
    }
  }
}

module.exports = { RateLimiter }
