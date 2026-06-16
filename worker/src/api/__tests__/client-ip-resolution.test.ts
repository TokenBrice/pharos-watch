import { describe, it, expect } from "vitest";
import { resolveClientIp } from "../api-key-requests/request";
import { resolveFeedbackClientIp } from "../feedback/request";

// Regression guard for audit Q-307: the rate-limit client IP must come ONLY from the
// edge-injected CF-Connecting-IP, never the client-controlled X-Forwarded-For header.
// If trusted, an attacker could rotate X-Forwarded-For to evade the IP-scoped bucket.
// When CF-Connecting-IP is absent, every request must collapse to one fixed sentinel.

const make = (headers: Record<string, string>) => new Request("https://pharos.watch/", { headers });

describe.each([
  ["api-key-requests resolveClientIp", resolveClientIp],
  ["feedback resolveFeedbackClientIp", resolveFeedbackClientIp],
])("%s", (_name, resolve) => {
  it("uses CF-Connecting-IP when present", () => {
    expect(resolve(make({ "CF-Connecting-IP": "203.0.113.10" }))).toBe("203.0.113.10");
  });

  it("ignores X-Forwarded-For and collapses to the 'unknown' sentinel when CF-Connecting-IP is absent", () => {
    expect(resolve(make({ "X-Forwarded-For": "1.1.1.1" }))).toBe("unknown");
    expect(resolve(make({ "X-Forwarded-For": "2.2.2.2" }))).toBe("unknown");
  });

  it("two different spoofed X-Forwarded-For values land in the same bucket", () => {
    const a = resolve(make({ "X-Forwarded-For": "1.1.1.1" }));
    const b = resolve(make({ "X-Forwarded-For": "9.9.9.9, 8.8.8.8" }));
    expect(a).toBe(b);
  });

  it("does not let X-Forwarded-For override a present CF-Connecting-IP", () => {
    expect(resolve(make({ "CF-Connecting-IP": "203.0.113.10", "X-Forwarded-For": "1.1.1.1" }))).toBe("203.0.113.10");
  });
});
