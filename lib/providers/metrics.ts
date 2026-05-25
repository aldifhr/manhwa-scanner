import { RedisClient } from "../types.js";

export interface ProviderMetrics {
  avgResponseTimeMs: number;
  lastSuccessAt: string | null;
  totalScrapes: number;
  successRate: number;
  history: number[]; // Last 20 response times
}

export class MetricsTracker {
  private metrics: ProviderMetrics = {
    avgResponseTimeMs: 0,
    lastSuccessAt: null,
    totalScrapes: 0,
    successRate: 0,
    history: []
  };

  private successes = 0;
  private failures = 0;

  record(responseTimeMs: number, success: boolean) {
    this.metrics.totalScrapes++;
    if (success) {
      this.successes++;
      this.metrics.lastSuccessAt = new Date().toISOString();
      this.metrics.history.push(responseTimeMs);
      if (this.metrics.history.length > 20) {
        this.metrics.history.shift();
      }
    } else {
      this.failures++;
    }

    // Calculate rolling average
    if (this.metrics.history.length > 0) {
      const sum = this.metrics.history.reduce((a, b) => a + b, 0);
      this.metrics.avgResponseTimeMs = Math.round(sum / this.metrics.history.length);
    }

    this.metrics.successRate = Math.round((this.successes / this.metrics.totalScrapes) * 100);
  }

  getMetrics() {
    return { ...this.metrics };
  }

  async persist(redis: RedisClient, providerId: string) {
    const key = `metrics:provider:${providerId}`;
    await redis.set(key, JSON.stringify(this.getMetrics()), { ex: 86400 * 7 }); // 7 days
  }

  async load(redis: RedisClient, providerId: string) {
    const key = `metrics:provider:${providerId}`;
    const data = await redis.get(key);
    if (data) {
      try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        if (parsed && typeof parsed === "object") {
          this.metrics = { ...this.metrics, ...(parsed as Partial<ProviderMetrics>) };
          this.successes = Math.round((this.metrics.successRate / 100) * this.metrics.totalScrapes);
          this.failures = this.metrics.totalScrapes - this.successes;
        }
      } catch {
        // Ignore parse error
      }
    }
  }
}
