/** Timing-safe string comparison for admin key validation.
 *  Hashes both inputs first so the comparison never leaks length. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aBuf, bBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

/** Returns a 401 Response if the request lacks a valid admin key, or null if authorized */
export async function requireAdmin(request: Request | undefined, adminKey: string | undefined): Promise<Response | null> {
  const provided = request?.headers.get("X-Admin-Key");
  if (!adminKey || !provided || !(await timingSafeEqual(provided, adminKey))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
