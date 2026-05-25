import { createClient } from "@supabase/supabase-js";
import { env } from "./config/env.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "supabase" });

// Ensure we have a valid URL and Key
const rawUrl = env.SUPABASE_URL || "";
const supabaseUrl = rawUrl.replace(/\/rest\/v1\/?$/, "");
const supabaseKey = env.SUPABASE_KEY || "";

if (!supabaseKey) {
  logger.warn("SUPABASE_KEY is missing. Supabase operations will fail.");
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
  },
});

const DEFAULT_SUPABASE_TIMEOUT_MS = 8000;

/**
 * Wraps a Supabase operation with a hard timeout so queries never hang indefinitely.
 * The underlying fetch is still in-flight after timeout but the caller proceeds.
 */
export async function withSupabaseTimeout<T>(
  fn: () => PromiseLike<T>,
  timeoutMs: number = DEFAULT_SUPABASE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Supabase query timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    fn().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err)    => { clearTimeout(timer); reject(err); },
    );
  });
}
