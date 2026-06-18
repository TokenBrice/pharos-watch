import { describe, it, expect } from "vitest";

import {
  decodeWatchlistToken,
  encodeWatchlistToken,
  MAX_WATCHLIST_TOKEN_CHARS,
} from "../telegram-watchlist-token";

function base64url(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("watchlist token codec (C129)", () => {
  it("round-trips coin ids, alert types, and preset ids", () => {
    const state = {
      coinIds: ["usdc-circle", "dai-makerdao"],
      alertTypes: ["dews", "depeg"],
      presetIds: ["usd-top25"],
    };
    const decoded = decodeWatchlistToken(encodeWatchlistToken(state));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.state).toEqual(state);
  });

  it("produces a url-safe, unpadded token", () => {
    const token = encodeWatchlistToken({ coinIds: ["usdc-circle"], alertTypes: ["dews"], presetIds: [] });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("tolerates a leading /import, code-block backticks, and whitespace/newlines", () => {
    const token = encodeWatchlistToken({ coinIds: ["usdc-circle"], alertTypes: ["dews"], presetIds: [] });
    const decoded = decodeWatchlistToken("/import  `" + token + "`\n");
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.state.coinIds).toEqual(["usdc-circle"]);
  });

  it("rejects empty input", () => {
    expect(decodeWatchlistToken("   ")).toEqual({ ok: false, error: "empty" });
  });

  it("rejects a token with no coins and no presets", () => {
    expect(decodeWatchlistToken(encodeWatchlistToken({ coinIds: [], alertTypes: ["dews"], presetIds: [] }))).toEqual({
      ok: false,
      error: "empty",
    });
  });

  it("rejects malformed base64 and valid-base64 non-JSON", () => {
    expect(decodeWatchlistToken("!!!not-base64!!!").ok).toBe(false);
    expect(decodeWatchlistToken(base64url("not json at all"))).toEqual({ ok: false, error: "malformed" });
  });

  it("rejects an unsupported (newer) version without partial apply", () => {
    expect(decodeWatchlistToken(base64url(JSON.stringify({ v: 2, c: ["usdc-circle"], t: [], p: [] })))).toEqual({
      ok: false,
      error: "unsupported-version",
    });
  });

  it("rejects an oversized token before decoding", () => {
    expect(decodeWatchlistToken("A".repeat(MAX_WATCHLIST_TOKEN_CHARS + 1))).toEqual({ ok: false, error: "too-large" });
  });
});
