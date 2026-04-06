import {
  debounce,
  throttle,
  cloneDeep,
  merge,
  get,
  set,
  unset,
  chunk,
  uniq,
  uniqBy,
  groupBy,
  orderBy,
  sortBy,
  filter,
  pick,
  omit,
  isEqual,
  isEmpty,
  isNil,
  isString,
  isNumber,
  isArray,
  isObject,
  isFunction,
  isDate,
  isRegExp,
  camelCase,
  kebabCase,
  snakeCase,
  startCase,
  truncate,
  trim,
  padStart,
  padEnd,
  escape,
  unescape,
  memoize,
  once,
  curry,
  flow,
  flatten,
  flattenDeep,
  difference,
  intersection,
  union,
  sample,
  shuffle,
  range,
  keyBy,
  mapValues,
  mapKeys,
  sum,
  sumBy,
  mean,
  max,
  min,
  maxBy,
  minBy,
  countBy,
  partition,
  take,
  drop,
  takeWhile,
  dropWhile,
  findIndex,
  findLastIndex,
  compact,
  zip,
  unzip,
} from "lodash-es";

// =================== Async Utilities ===================

/**
 * Debounce a function - delays execution until after wait milliseconds have elapsed
 * since the last time the debounced function was invoked.
 */
export function debounceFn(func, wait = 300, options = {}) {
  return debounce(func, wait, options);
}

/**
 * Throttle a function - only allows execution at most once per every wait milliseconds
 */
export function throttleFn(func, wait = 300, options = {}) {
  return throttle(func, wait, options);
}

/**
 * Memoize a function - caches results based on arguments
 */
export function memoizeFn(func, resolver) {
  return memoize(func, resolver);
}

/**
 * Create a function that can only be called once
 */
export function onceFn(func) {
  return once(func);
}

/**
 * Curry a function
 */
export function curryFn(func, arity) {
  return curry(func, arity);
}

/**
 * Compose multiple functions from left to right
 */
export function compose(...funcs) {
  return flow(...funcs);
}

// =================== Object Utilities ===================

/**
 * Deep clone an object or array
 */
export function deepClone(obj) {
  return cloneDeep(obj);
}

/**
 * Deep merge objects
 */
export function deepMerge(target, ...sources) {
  return merge({}, target, ...sources);
}

/**
 * Safely get a nested value from an object
 */
export function getValue(obj, path, defaultValue) {
  return get(obj, path, defaultValue);
}

/**
 * Safely set a nested value in an object
 */
export function setValue(obj, path, value) {
  return set(obj, path, value);
}

/**
 * Remove a nested value from an object
 */
export function unsetValue(obj, path) {
  return unset(obj, path);
}

/**
 * Pick specific keys from an object
 */
export function pickKeys(obj, keys) {
  return pick(obj, keys);
}

/**
 * Omit specific keys from an object
 */
export function omitKeys(obj, keys) {
  return omit(obj, keys);
}

/**
 * Check if two values are deeply equal
 */
export function deepEqual(a, b) {
  return isEqual(a, b);
}

/**
 * Check if value is empty (empty object, array, string, null, undefined)
 */
export function isEmptyValue(value) {
  return isEmpty(value);
}

/**
 * Check if value is nil (null or undefined)
 */
export function isNilValue(value) {
  return isNil(value);
}

/**
 * Type checking utilities
 */
export const is = {
  string: isString,
  number: isNumber,
  array: isArray,
  object: isObject,
  function: isFunction,
  date: isDate,
  regExp: isRegExp,
  empty: isEmpty,
  nil: isNil,
  equal: isEqual,
};

// =================== Array Utilities ===================

/**
 * Remove duplicate values from an array
 */
export function unique(arr) {
  return uniq(arr);
}

/**
 * Remove duplicate values based on a key or function
 */
export function uniqueBy(arr, iteratee) {
  return uniqBy(arr, iteratee);
}

/**
 * Group array items by a key
 */
export function groupByKey(arr, key) {
  return groupBy(arr, key);
}

/**
 * Sort array by key(s) - ascending
 */
export function sortByKey(arr, iteratees) {
  return sortBy(arr, iteratees);
}

/**
 * Sort array by key(s) - with custom order
 */
export function orderByKey(arr, iteratees, orders) {
  return orderBy(arr, iteratees, orders);
}

/**
 * Filter array by condition
 */
export function filterArray(arr, predicate) {
  return filter(arr, predicate);
}

/**
 * Chunk array into smaller arrays of specified size
 */
export function chunkArray(arr, size) {
  return chunk(arr, size);
}

/**
 * Flatten array one level deep
 */
export function flattenArray(arr) {
  return flatten(arr);
}

/**
 * Deep flatten array
 */
export function flattenDeepArray(arr) {
  return flattenDeep(arr);
}

/**
 * Get difference between two arrays
 */
export function arrayDifference(arr1, arr2) {
  return difference(arr1, arr2);
}

/**
 * Get intersection of two arrays
 */
export function arrayIntersection(arr1, arr2) {
  return intersection(arr1, arr2);
}

/**
 * Get union of two arrays (unique values from both)
 */
export function arrayUnion(arr1, arr2) {
  return union(arr1, arr2);
}

/**
 * Get random sample from array
 */
export function arraySample(arr, n = 1) {
  return n === 1 ? sample(arr) : sample(arr, n);
}

/**
 * Shuffle array
 */
export function shuffleArray(arr) {
  return shuffle(arr);
}

/**
 * Create range of numbers
 */
export function numberRange(start, end, step) {
  return range(start, end, step);
}

/**
 * Create object from array by key
 */
export function keyByField(arr, key) {
  return keyBy(arr, key);
}

/**
 * Map values of an object
 */
export function mapObjectValues(obj, iteratee) {
  return mapValues(obj, iteratee);
}

/**
 * Map keys of an object
 */
export function mapObjectKeys(obj, iteratee) {
  return mapKeys(obj, iteratee);
}

/**
 * Sum array values
 */
export function sumArray(arr) {
  return sum(arr);
}

/**
 * Sum array values by key
 */
export function sumByKey(arr, iteratee) {
  return sumBy(arr, iteratee);
}

/**
 * Get mean average
 */
export function meanArray(arr) {
  return mean(arr);
}

/**
 * Get max value
 */
export function maxArray(arr) {
  return max(arr);
}

/**
 * Get min value
 */
export function minArray(arr) {
  return min(arr);
}

/**
 * Get max value by key
 */
export function maxByKey(arr, iteratee) {
  return maxBy(arr, iteratee);
}

/**
 * Get min value by key
 */
export function minByKey(arr, iteratee) {
  return minBy(arr, iteratee);
}

/**
 * Count occurrences
 */
export function countByKey(arr, iteratee) {
  return countBy(arr, iteratee);
}

/**
 * Partition array into two groups based on predicate
 */
export function partitionArray(arr, predicate) {
  return partition(arr, predicate);
}

/**
 * Take first n elements
 */
export function takeFirst(arr, n = 1) {
  return take(arr, n);
}

/**
 * Drop first n elements
 */
export function dropFirst(arr, n = 1) {
  return drop(arr, n);
}

/**
 * Take elements while predicate is true
 */
export function takeWhileMatch(arr, predicate) {
  return takeWhile(arr, predicate);
}

/**
 * Drop elements while predicate is true
 */
export function dropWhileMatch(arr, predicate) {
  return dropWhile(arr, predicate);
}

/**
 * Find index of element matching predicate
 */
export function findIndexOf(arr, predicate, fromIndex = 0) {
  return findIndex(arr, predicate, fromIndex);
}

/**
 * Find last index of element matching predicate
 */
export function findLastIndexOf(arr, predicate, fromIndex) {
  return findLastIndex(arr, predicate, fromIndex);
}

/**
 * Remove falsy values from array
 */
export function compactArray(arr) {
  return compact(arr);
}

/**
 * Zip multiple arrays together
 */
export function zipArrays(...arrays) {
  return zip(...arrays);
}

/**
 * Unzip array of arrays
 */
export function unzipArrays(arr) {
  return unzip(arr);
}

// =================== String Utilities ===================

/**
 * Convert string to camelCase
 */
export function toCamelCase(str) {
  return camelCase(str);
}

/**
 * Convert string to kebab-case
 */
export function toKebabCase(str) {
  return kebabCase(str);
}

/**
 * Convert string to snake_case
 */
export function toSnakeCase(str) {
  return snakeCase(str);
}

/**
 * Convert string to Title Case
 */
export function toTitleCase(str) {
  return startCase(str);
}

/**
 * Truncate string to specified length
 */
export function truncateString(str, options = {}) {
  return truncate(str, {
    length: options.length || 30,
    omission: options.omission || "...",
    separator: options.separator,
  });
}

/**
 * Trim whitespace from string
 */
export function trimString(str, chars) {
  return chars ? trim(str, chars) : trim(str);
}

/**
 * Pad string from start
 */
export function padStartString(str, length, chars) {
  return padStart(str, length, chars);
}

/**
 * Pad string from end
 */
export function padEndString(str, length, chars) {
  return padEnd(str, length, chars);
}

/**
 * Escape HTML entities
 */
export function escapeHtml(str) {
  return escape(str);
}

/**
 * Unescape HTML entities
 */
export function unescapeHtml(str) {
  return unescape(str);
}

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

/**
 * Run promises in batches with concurrency limit
 */
export async function batchAsync(items, fn, concurrency = 5) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);

    if (items.length >= concurrency) {
      executing.push(p);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }

  return Promise.all(results);
}

// =================== Data Transformations ===================

/**
 * Transform snake_case keys to camelCase recursively
 */
export function keysToCamelCase(obj) {
  if (isArray(obj)) {
    return obj.map((v) => keysToCamelCase(v));
  }
  if (isObject(obj) && !isDate(obj) && !isRegExp(obj)) {
    return mapKeys(obj, (v, k) => camelCase(k));
  }
  return obj;
}

/**
 * Transform camelCase keys to snake_case recursively
 */
export function keysToSnakeCase(obj) {
  if (isArray(obj)) {
    return obj.map((v) => keysToSnakeCase(v));
  }
  if (isObject(obj) && !isDate(obj) && !isRegExp(obj)) {
    return mapKeys(obj, (v, k) => snakeCase(k));
  }
  return obj;
}

/**
 * Remove null and undefined values from object recursively
 */
export function removeNilValues(obj) {
  if (isArray(obj)) {
    return obj.map(removeNilValues).filter((v) => !isNil(v));
  }
  if (isObject(obj)) {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([, v]) => !isNil(v))
        .map(([k, v]) => [k, removeNilValues(v)])
    );
  }
  return obj;
}

/**
 * Sanitize object for logging (remove sensitive fields)
 */
export function sanitizeForLogging(obj, sensitiveFields = []) {
  const defaultSensitive = [
    "password",
    "token",
    "secret",
    "apiKey",
    "api_key",
    "authorization",
    "auth",
    "cookie",
    "session",
    "creditCard",
    "credit_card",
    "cvv",
    "ssn",
  ];
  const fieldsToRemove = [...defaultSensitive, ...sensitiveFields];

  return mapValues(obj, (value, key) => {
    if (fieldsToRemove.some((f) => key.toLowerCase().includes(f))) {
      return "[REDACTED]";
    }
    if (isObject(value) && !isArray(value)) {
      return sanitizeForLogging(value, sensitiveFields);
    }
    return value;
  });
}

// =================== Export all for convenience ===================

export {
  debounce,
  throttle,
  cloneDeep,
  merge,
  get,
  set,
  unset,
  chunk,
  uniq,
  uniqBy,
  groupBy,
  orderBy,
  sortBy,
  filter,
  pick,
  omit,
  isEqual,
  isEmpty,
  isNil,
  isString,
  isNumber,
  isArray,
  isObject,
  isFunction,
  isDate,
  isRegExp,
  camelCase,
  kebabCase,
  snakeCase,
  startCase,
  truncate,
  trim,
  padStart,
  padEnd,
  escape,
  unescape,
  memoize,
  once,
  curry,
  flow,
  flatten,
  flattenDeep,
  difference,
  intersection,
  union,
  sample,
  shuffle,
  range,
  keyBy,
  mapValues,
  mapKeys,
  sum,
  sumBy,
  mean,
  max,
  min,
  maxBy,
  minBy,
  countBy,
  partition,
  take,
  drop,
  takeWhile,
  dropWhile,
  findIndex,
  findLastIndex,
  compact,
  zip,
  unzip,
};
