/**
 * Bounded LRU Map for Discord in-flight request deduplication
 * Prevents memory leaks by limiting max entries and using LRU eviction
 */

export interface BoundedMapOptions {
  maxSize: number;
  defaultTtlMs: number;
}

export class BoundedInFlightMap<K, V> {
  private map = new Map<K, { value: V; timestamp: number }>();
  private maxSize: number;
  private defaultTtlMs: number;

  constructor(options: BoundedMapOptions) {
    this.maxSize = options.maxSize;
    this.defaultTtlMs = options.defaultTtlMs;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.defaultTtlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.defaultTtlMs) {
      this.map.delete(key);
      return undefined;
    }
    
    // Update timestamp for LRU
    entry.timestamp = Date.now();
    return entry.value;
  }

  set(key: K, value: V): void {
    // If at capacity, evict oldest entry
    if (this.map.size >= this.maxSize && !this.map.has(key)) {
      this.evictLRU();
    }
    
    this.map.set(key, { value, timestamp: Date.now() });
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }

  private evictLRU(): void {
    // Find and remove oldest entry
    let oldestKey: K | undefined;
    let oldestTime = Infinity;
    
    for (const [key, entry] of this.map) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    
    if (oldestKey !== undefined) {
      this.map.delete(oldestKey);
    }
  }

  // Cleanup expired entries periodically
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.map) {
      if (now - entry.timestamp > this.defaultTtlMs) {
        this.map.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}
