/**
 * Cryptographic utilities for auth
 * - Base64Url encoding/decoding
 * - HMAC signing (Node.js and Web Crypto)
 * - Constant-time comparison
 */

// Determine runtime environment
const IS_EDGE = typeof process !== "undefined" && process.env.NEXT_RUNTIME === "edge";
const IS_NODE = !IS_EDGE;

/**
 * Universal Base64Url encoder that works in both Node.js and Edge Runtime
 */
export function toBase64Url(input: Uint8Array | string): string {
  let binStr = "";
  if (typeof input === "string") {
    binStr = btoa(unescape(encodeURIComponent(input)));
  } else {
    // For Uint8Array
    input.forEach((b) => { binStr += String.fromCharCode(b); });
    binStr = btoa(binStr);
  }

  return binStr
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Universal Base64Url decoder
 */
export function fromBase64Url(input: string): string {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const binStr = atob(normalized);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Sign value with HMAC-SHA256
 */
export async function signValue(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(value);
  const keyBuffer = encoder.encode(secret);

  if (IS_NODE) {
    try {
      const { createHmac } = await import("crypto");
      const hmac = createHmac("sha256", secret).update(value).digest();
      return toBase64Url(new Uint8Array(hmac));
    } catch {
      // Fallback to Web Crypto if Node crypto fails
    }
  }

  const subtle = crypto.subtle || (crypto as unknown as { webcrypto: { subtle: SubtleCrypto } }).webcrypto?.subtle;
  const cryptoKey = await subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await subtle.sign("HMAC", cryptoKey, dataBuffer);
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? "");
  const right = String(b ?? "");

  if (left.length !== right.length) return false;

  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}
