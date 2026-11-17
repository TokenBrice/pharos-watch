import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "../base64url";
import {
  buildSiteSessionCookie, hasSiteSessionSigningKey, mintSiteSessionToken, readSiteSessionCookie, verifySiteSessionToken,
  SITE_SESSION_COOKIE_NAME, SITE_SESSION_BROWSER_TTL_SEC, SITE_SESSION_AUTOMATION_TTL_SEC,
} from "../site-session-token";

const key = "test-signing-key", nowSec = 1700000000;
const payload = { v: 1, sid: "session-id", kind: "browser", iat: nowSec, exp: nowSec + 120 };
const encode = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

describe("site session tokens", () => {
  it.each([
    ["browser", 43200], ["browser", SITE_SESSION_BROWSER_TTL_SEC], ["automation", SITE_SESSION_AUTOMATION_TTL_SEC],
  ] as const)("round trips %s", async (kind, ttl) => {
    const token = await mintSiteSessionToken({ key, kind, nowSec, ttlSec: ttl === 43200 ? ttl : undefined });
    const result = await verifySiteSessionToken({ token, keys: [key], nowSec });
    expect(result).toEqual({ ok: true, payload: { v: 1, kind, iat: nowSec, exp: nowSec + ttl, sid: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) } });
  });

  it.each([
    [0, [key], null], [179, [key], null], [180, [key], "expired"],
    [-60, [key], null], [-61, [key], "not-yet-valid"],
    [0, ["wrong"], "bad-signature"], [0, [null, "", undefined, "new-key", key], null],
    [0, [], "bad-signature"], [0, [`  ${key}\n`], null], [0, ["  "], "bad-signature"],
  ] as const)("checks time offset %s and rotation keys %j", async (offset, keys, reason) => {
    const token = await mintSiteSessionToken({ key, kind: "browser", nowSec, ttlSec: 120, sid: payload.sid });
    expect(await verifySiteSessionToken({ token, keys, nowSec: nowSec + offset }))
      .toEqual(reason ? { ok: false, reason } : { ok: true, payload });
  });

  it("matches an HMAC-SHA256 vector and rejects tampering", async () => {
    const token = await mintSiteSessionToken({ key, kind: "browser", nowSec, ttlSec: 120, sid: payload.sid });
    expect(token).toBe(`${encode(payload)}.9RYwzvjYiLj-LIl8B8WF1Lc0Trdh7DhihTh0uf6aZW0`);
    expect(await mintSiteSessionToken({ key: `  ${key}\n`, kind: "browser", nowSec, ttlSec: 120, sid: payload.sid })).toBe(token);
    for (const key of ["", " \n"]) {
      expect(hasSiteSessionSigningKey(key)).toBe(false);
      expect(await mintSiteSessionToken({ key, kind: "automation", nowSec })).toBe("");
    }
    const tampered = `${encode({ ...payload, sid: "attacker" })}.${token.split(".")[1]}`;
    expect(await verifySiteSessionToken({ token: tampered, keys: [key], nowSec })).toEqual({ ok: false, reason: "bad-signature" });
  });

  it.each([
    null, undefined, "", "no-dot", "a.b.c", ".", "!.AA", "A.AA", "a".repeat(513),
    ...[null, [], { ...payload, v: 2 }, { ...payload, kind: "other" }, { ...payload, sid: 1 }, { ...payload, sid: "" },
      { ...payload, exp: nowSec + 604801 }, { ...payload, kind: "automation", exp: nowSec + 901 },
      { ...payload, iat: "1700000000" }, { ...payload, iat: 1.5 }, { ...payload, exp: null },
      { ...payload, exp: nowSec }, { ...payload, extra: true }].map((value) => `${encode(value)}.${"A".repeat(43)}`),
  ])("rejects invalid %j", async (token) => {
    expect(await verifySiteSessionToken({ token, keys: [key], nowSec }))
      .toEqual({ ok: false, reason: token ? "malformed" : "missing" });
  });

  it.each([
    [null, null], [undefined, null], ["other=abc", null], [`${SITE_SESSION_COOKIE_NAME}=`, null],
    [`other=abc; ${SITE_SESSION_COOKIE_NAME}=payload.signature; last=z`, "payload.signature"],
    [`prefix${SITE_SESSION_COOKIE_NAME}=no; ${SITE_SESSION_COOKIE_NAME}=a=b`, "a=b"],
  ])("reads cookie %j", (header, expected) => {
    expect(readSiteSessionCookie(header)).toBe(expected);
  });

  it("builds the scoped secure cookie", () => {
    expect(buildSiteSessionCookie("payload.signature", 604800)).toBe(
      "__Secure-pharos-session=payload.signature; Path=/_site-data; Secure; HttpOnly; SameSite=Strict; Max-Age=604800",
    );
  });
});
