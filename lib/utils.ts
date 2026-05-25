import { 
  chunk, 
  compact, 
} from "lodash-es";

export function arrayUnion<T>(...arrays: T[][]): T[] {
  const result = new Set<T>();
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        result.add(item);
      }
    }
  }
  return Array.from(result);
}

export function arrayUnique<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  return chunk(arr, size);
}

export function compactArray<T>(arr: (T | null | undefined | false | "" | 0)[]): T[] {
  return compact(arr) as T[];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    delay?: number;
    backoff?: number;
    shouldRetry?: (error: any, attempt: number) => boolean;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 1000,
    backoff = 2,
    shouldRetry = () => true,
  } = options;

  let lastError: any;
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

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Operation timed out",
  lifecycle?: { currentStep: string },
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const stepInfo = lifecycle?.currentStep ? ` during ${lifecycle.currentStep}` : "";
      reject(new Error(`${message}${stepInfo}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
export function isApproachingTimeout(
  startTime: number,
  totalTimeoutMs: number,
  bufferMs = 5000,
): boolean {
  return Date.now() - startTime > totalTimeoutMs - bufferMs;
}
