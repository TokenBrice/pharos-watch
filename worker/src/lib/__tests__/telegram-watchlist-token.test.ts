import searchableCoinsAsset from "@shared/data/stablecoins/coins.telegram-mini-app.generated.json";
import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import { describe, expect, it } from "vitest";

import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../telegram-constants";
import {
  decodeWatchlistToken,
  encodeWatchlistToken,
  encodeWatchlistTokenV2,
  MAX_WATCHLIST_TOKEN_CHARS,
  WATCHLIST_TOKEN_REGISTRY_VERSION,
  type WatchlistTokenDirectState,
  type WatchlistTokenV2State,
} from "../telegram-watchlist-token";

function base64url(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function direct(stablecoinId: string, overrides = false): WatchlistTokenDirectState {
  return {
    stablecoinId,
    alertDews: true,
    alertDepeg: true,
    alertSafety: false,
    alertLaunch: true,
    alertReserve: false,
    overrideDews: overrides,
    overrideDepeg: true,
    overrideSafety: overrides,
    overrideLaunch: true,
    overrideReserve: overrides,
    dewsMinBand: "WARNING",
    safetyMode: "downgrade-only",
    depegWorseningBpsStep: 250,
  };
}

describe("watchlist token codec", () => {
  it("keeps v1 byte compatibility and reads copy/paste artifacts", async () => {
    const state = {
      coinIds: ["usdc-circle", "dai-makerdao"],
      alertTypes: ["dews", "depeg", "safety"],
      presetIds: ["usd-top25"],
    };
    const body = JSON.stringify({ v: 1, c: state.coinIds, t: state.alertTypes, p: state.presetIds });
    const legacy = btoa(body).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(encodeWatchlistToken(state)).toBe(legacy);
    await expect(decodeWatchlistToken(`/import  \`${legacy}\`\n`)).resolves.toEqual({
      ok: true,
      version: 1,
      state,
    });
  });

  it("round-trips every v2 direct override/tuning field and preset intent", async () => {
    const state: WatchlistTokenV2State = {
      registryVersion: WATCHLIST_TOKEN_REGISTRY_VERSION,
      direct: [direct("usdc-circle", true), {
        ...direct("dai-makerdao"),
        alertDews: false,
        alertDepeg: false,
        alertSafety: true,
        alertLaunch: false,
        alertReserve: true,
        dewsMinBand: "DANGER",
        safetyMode: "upgrade-only",
        depegWorseningBpsStep: 500,
      }],
      presets: [{
        presetId: "usd-top25",
        alertDews: true,
        alertDepeg: false,
        alertSafety: true,
        depegWorseningBpsStep: 100,
      }],
    };
    const token = await encodeWatchlistTokenV2(state);
    expect(token).toMatch(/^pw2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await expect(decodeWatchlistToken(token)).resolves.toEqual({
      ok: true,
      version: 2,
      state: { ...state, direct: [...state.direct].sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId)) },
    });
  });

  it("treats the embedded catalog version as provenance, not an index dependency", async () => {
    const state: WatchlistTokenV2State = {
      registryVersion: "catalog-v0-historical",
      direct: [direct("usdc-circle")],
      presets: [],
    };
    const decoded = await decodeWatchlistToken(await encodeWatchlistTokenV2(state));
    expect(decoded).toMatchObject({ ok: true, version: 2, state: { registryVersion: "catalog-v0-historical" } });
  });

  it("fits the maximum current subscribable registry in one export code-block line with headroom", async () => {
    const state: WatchlistTokenV2State = {
      registryVersion: WATCHLIST_TOKEN_REGISTRY_VERSION,
      direct: searchableCoinsAsset.map((coin, index) => ({
        stablecoinId: coin.stablecoinId,
        alertDews: Boolean(index & 1),
        alertDepeg: Boolean(index & 2),
        alertSafety: Boolean(index & 4),
        alertLaunch: Boolean(index & 8),
        alertReserve: Boolean(index & 16),
        overrideDews: Boolean(index & 32),
        overrideDepeg: Boolean(index & 64),
        overrideSafety: Boolean(index & 128),
        overrideLaunch: Boolean(index & 256),
        overrideReserve: Boolean(index & 1) !== Boolean(index & 32),
        dewsMinBand: ([null, "ALERT", "WARNING", "DANGER"] as const)[index % 4],
        safetyMode: ([null, "all", "downgrade-only", "upgrade-only"] as const)[Math.floor(index / 4) % 4],
        depegWorseningBpsStep: ([null, 100, 250, 500] as const)[Math.floor(index / 16) % 4],
      })),
      presets: TELEGRAM_PRESET_IDS.map((presetId, index) => ({
        presetId,
        alertDews: Boolean(index & 1),
        alertDepeg: Boolean(index & 2),
        alertSafety: Boolean(index & 4),
        depegWorseningBpsStep: ([null, 100, 250, 500] as const)[index % 4],
      })),
    };
    const token = await encodeWatchlistTokenV2(state);
    expect(token.length).toBeLessThanOrEqual(MAX_WATCHLIST_TOKEN_CHARS);
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT - (`<pre>${token}</pre>`).length).toBeGreaterThanOrEqual(80);
    expect(4096 - (`/import ${token}`).length).toBeGreaterThanOrEqual(175);
    const decoded = await decodeWatchlistToken(token);
    expect(decoded).toEqual({
      ok: true,
      version: 2,
      state: {
        ...state,
        direct: [...state.direct].sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId)),
        presets: [...state.presets].sort((a, b) => a.presetId.localeCompare(b.presetId)),
      },
    });
  });

  it("rejects altered v2 payloads through the corruption/tamper digest", async () => {
    const token = await encodeWatchlistTokenV2({
      registryVersion: WATCHLIST_TOKEN_REGISTRY_VERSION,
      direct: [direct("usdc-circle")],
      presets: [],
    });
    const parts = token.split(".");
    const payload = parts[1];
    const replacement = payload[0] === "A" ? "B" : "A";
    const altered = `${parts[0]}.${replacement}${payload.slice(1)}.${parts[2]}`;
    await expect(decodeWatchlistToken(altered)).resolves.toEqual({ ok: false, error: "integrity" });
  });

  it("rejects empty, malformed, unsupported, and oversized inputs", async () => {
    await expect(decodeWatchlistToken("   ")).resolves.toEqual({ ok: false, error: "empty" });
    await expect(decodeWatchlistToken("!!!not-base64!!!")).resolves.toEqual({ ok: false, error: "malformed" });
    await expect(decodeWatchlistToken(base64url("not json at all"))).resolves.toEqual({ ok: false, error: "malformed" });
    await expect(decodeWatchlistToken(base64url(JSON.stringify({ v: 3, c: ["usdc-circle"], t: [], p: [] })))).resolves.toEqual({
      ok: false,
      error: "unsupported-version",
    });
    await expect(decodeWatchlistToken(`pw2.${"A".repeat(MAX_WATCHLIST_TOKEN_CHARS)}.AAAAAAAAAAAAAAAA`)).resolves.toEqual({
      ok: false,
      error: "too-large",
    });
  });

  it("retains the historical 4000-character v1 read boundary", async () => {
    const accepted = encodeWatchlistToken({ coinIds: ["x".repeat(2_960)], alertTypes: ["dews"], presetIds: [] });
    expect(accepted.length).toBeGreaterThan(MAX_WATCHLIST_TOKEN_CHARS);
    expect(accepted.length).toBeLessThanOrEqual(4000);
    const decoded = await decodeWatchlistToken(accepted);
    expect(decoded.ok && decoded.version === 1 ? decoded.state.coinIds[0]?.length : 0).toBe(2_960);

    const rejected = encodeWatchlistToken({ coinIds: ["x".repeat(3_000)], alertTypes: ["dews"], presetIds: [] });
    expect(rejected.length).toBeGreaterThan(4000);
    await expect(decodeWatchlistToken(rejected)).resolves.toEqual({ ok: false, error: "too-large" });
  });
});
