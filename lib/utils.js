import {
  union as arrayUnion,
  chunk,
  compact,
  uniqBy,
  uniq,
  debounce,
  throttle,
  memoize,
  cloneDeep,
  merge,
  get,
} from "lodash-es";

// =================== Async Helpers ===================

/**
 * Sleep/delay for specified milliseconds
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff
 */
export async function retryAsync(fn, options = {}) {
  const {
    maxAttempts = 3,
    delay = 1000,
    backoff = 2,
    shouldRetry = () => true,
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error, attempt)) {
        throw error;
      }
      await sleep(delay * Math.pow(backoff, attempt - 1));
    }
  }
  throw lastError;
}

/**
 * Timeout wrapper for promises
 */
export function withTimeout(promise, ms, message = "Operation timed out") {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]);
}

// =================== Array Utilities ===================

/**
 * Remove duplicate values based on a key or function
 */
export function uniqueBy(arr, iteratee) {
  return uniqBy(arr, iteratee);
}

/**
 * Remove duplicate values from array
 */
export function unique(arr) {
  return uniq(arr);
}

/**
 * Debounce a function
 */
export function debounceFn(fn, wait, options) {
  return debounce(fn, wait, options);
}

/**
 * Throttle a function
 */
export function throttleFn(fn, wait, options) {
  return throttle(fn, wait, options);
}

/**
 * Memoize a function
 */
export function memoizeFn(fn, resolver) {
  return memoize(fn, resolver);
}

/**
 * Deep clone an object
 */
export function deepClone(obj) {
  return cloneDeep(obj);
}

/**
 * Deep merge objects
 */
export function deepMerge(target, ...sources) {
  return merge(target, ...sources);
}

/**
 * Get nested value from object
 */
export function getValue(obj, path, defaultValue) {
  return get(obj, path, defaultValue);
}

/**
 * Sort array of objects by key (ascending)
 */
export function sortByKey(arr, key) {
  if (!Array.isArray(arr)) return [];
  return [...arr].sort((a, b) => {
    const valA = get(a, key);
    const valB = get(b, key);
    if (valA < valB) return -1;
    if (valA > valB) return 1;
    return 0;
  });
}

/**
 * Filter array by predicate (alias)
 */
export function filterArray(arr, predicate) {
  return Array.isArray(arr) ? arr.filter(predicate) : [];
}

/**
 * Chunk array into smaller arrays of specified size
 */
export function chunkArray(arr, size) {
  return chunk(arr, size);
}

/**
 * Remove falsy values from array
 */
export function compactArray(arr) {
  return compact(arr);
}

/**
 * Group array of objects by a common key
 */
export function groupByKey(arr, key) {
  if (!Array.isArray(arr)) return {};
  return arr.reduce((acc, obj) => {
    const val = obj[key] || "unknown";
    if (!acc[val]) acc[val] = [];
    acc[val].push(obj);
    return acc;
  }, {});
}

/**
 * Safe JSON parse that returns fallback instead of throwing
 */
export function safeJsonParse(data, fallback = null) {
  if (data === null || data === undefined) return fallback;
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}

/**
 * Get union of two arrays (unique values from both)
 */
export { arrayUnion };

/**
 * Returns an appropriate error message based on the current environment.
 */
export function formatErrorMessage(err, fallback = "Internal error") {
  const isProd = process.env.NODE_ENV === "production";

  if (!err) return fallback;
  if (isProd) return fallback;

  if (typeof err === "string") {
    return err.trim() || fallback;
  }

  if (err && typeof err.message === "string") {
    return err.message;
  }

  return fallback;
}
