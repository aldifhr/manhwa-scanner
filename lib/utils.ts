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
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function compactArray<T>(arr: (T | null | undefined | false | "" | 0)[]): T[] {
  return arr.filter(Boolean) as T[];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
