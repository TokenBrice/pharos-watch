/**
 * Fetch with retry and exponential backoff.
 * Respects Retry-After header on 429 responses.
 * Returns null if all attempts fail.
 */
export async function fetchWithRetry(
  url: string,
  opts?: RequestInit,
  maxRetries = 2,
  options?: { passthrough404?: boolean; timeoutMs?: number }
): Promise<Response | null> {
  const passthrough404 = options?.passthrough404 ?? false;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: opts?.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      if (res.status === 404 && passthrough404) return res;

      if (res.status === 429 && i < maxRetries) {
        const retryAfter = res.headers.get("Retry-After");
        const waitSec = retryAfter ? parseInt(retryAfter, 10) : 0;
        const waitMs = waitSec > 0 && waitSec <= 120 ? waitSec * 1000 : 5000;
        console.warn(`[fetch-retry] ${url} rate-limited (429), waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      console.warn(`[fetch-retry] ${url} returned ${res.status} (attempt ${i + 1}/${maxRetries + 1})`);
    } catch (err) {
      console.warn(`[fetch-retry] ${url} failed (attempt ${i + 1}/${maxRetries + 1}):`, err);
    }
    if (i < maxRetries) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  return null;
}
