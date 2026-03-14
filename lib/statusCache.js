export const STATUS_EMPTY_CACHE_VALUE = "__STATUS_NULL__";

export function hasStatusCacheValue(value) {
  return value !== null && value !== undefined;
}

export function decodeStatusCacheValue(value) {
  if (value === STATUS_EMPTY_CACHE_VALUE) return null;
  return value;
}

export function encodeStatusCacheValue(value) {
  return value === null ? STATUS_EMPTY_CACHE_VALUE : value;
}
