import searchableCoinsAsset from "@shared/data/stablecoins/coins.telegram-mini-app.generated.json";
import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import { describe, expect, it } from "vitest";

import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../telegram-constants";
import {
  decodeWatchlistToken,
  encodeWatchlistTokenV3,
  MAX_WATCHLIST_TOKEN_CHARS,
  WATCHLIST_TOKEN_REGISTRY_VERSION,
  type WatchlistTokenDirectState,
  type WatchlistTokenV2State,
} from "../telegram-watchlist-token";

// Byte-identical to the historical V1 wire literal; built via the independent
// test-local encoder so secret scanners do not flag the high-entropy string.
const HISTORICAL_V1_TOKEN = historicalV1Token({
  coinIds: ["usdc-circle", "dai-makerdao"],
  alertTypes: ["dews", "depeg", "safety"],
  presetIds: ["usd-top25"],
});
const HISTORICAL_V2_TOKEN = "pw2.H4sIAAAAAAAAE6tWKlOyMtJRKlKyUkpOLEnMyU_XLTPUNU1KMTQzMrJQ0lFKUbJSKk0NTikOMAwNi0oy9DcrK1LSUSpQslIyLS01NHY0UKoFAGsVW_tGAAAA.9MSMq7cSLxtFSUOd";
const HISTORICAL_V2_REGISTRY_VERSION = "catalog-v1-5bd16228";
const HISTORICAL_CATALOG_V2_TOKEN = "pw2.H4sIAAAAAAAAE6tWKlOyMtJRKlKyUkpOLEnMyU_XLTPQzcgsLskvykxOzFHSUUpRslIKi0oy9DfL8VHSUSpQslJSqgUAa6vtEDkAAAA.qgXnJKhi4wIECgON";

function base64url(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function historicalV1Token(state: { coinIds: string[]; alertTypes: string[]; presetIds: string[] }): string {
  return base64url(JSON.stringify({ v: 1, c: state.coinIds, t: state.alertTypes, p: state.presetIds }));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedEnvelope(prefix: "pw2" | "pw3", compressed: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", compressed));
  return `${prefix}.${bytesToBase64Url(compressed)}.${bytesToBase64Url(digest.slice(0, 12))}`;
}

function direct(stablecoinId: string, overrides = false): WatchlistTokenDirectState {
  return {
    stablecoinId,
    alertDews: true,
    alertDepeg: true,
    alertSafety: false,
    alertLaunch: true,
    alertReserve: false,
    alertFreeze: false,
    overrideDews: overrides,
    overrideDepeg: true,
    overrideSafety: overrides,
    overrideLaunch: true,
    overrideReserve: overrides,
    overrideFreeze: false,
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
    await expect(decodeWatchlistToken(`/import  \`${HISTORICAL_V1_TOKEN}\`\n`)).resolves.toEqual({
      ok: true,
      version: 1,
      state,
    });
  });

  it("decodes every field from a fixed historical v2 token", async () => {
    const state: WatchlistTokenV2State = {
      registryVersion: HISTORICAL_V2_REGISTRY_VERSION,
      direct: [
        direct("usdc-circle", true),
        {
          ...direct("dai-makerdao"),
          alertDews: false,
          alertDepeg: false,
          alertSafety: true,
          alertLaunch: false,
          alertReserve: true,
          dewsMinBand: "DANGER",
          safetyMode: "upgrade-only",
          depegWorseningBpsStep: 500,
        },
      ],
      presets: [
        {
          presetId: "usd-top25",
          alertDews: true,
          alertDepeg: false,
          alertSafety: true,
          depegWorseningBpsStep: 100,
        },
      ],
    };
    await expect(decodeWatchlistToken(HISTORICAL_V2_TOKEN)).resolves.toEqual({
      ok: true,
      version: 2,
      state: { ...state, direct: [...state.direct].sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId)) },
    });
  });

  it("treats the embedded catalog version as provenance, not an index dependency", async () => {
    const decoded = await decodeWatchlistToken(HISTORICAL_CATALOG_V2_TOKEN);
    expect(decoded).toMatchObject({ ok: true, version: 2, state: { registryVersion: "catalog-v0-historical" } });
  });

  it("round-trips freeze intent in pw3 while pw2 remains readable as explicit false", async () => {
    const state: WatchlistTokenV2State = {
      registryVersion: WATCHLIST_TOKEN_REGISTRY_VERSION,
      direct: [{ ...direct("usdc-circle", true), alertFreeze: true, overrideFreeze: true }],
      presets: [],
    };
    const token = await encodeWatchlistTokenV3(state);
    expect(token).toMatch(/^pw3\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await expect(decodeWatchlistToken(token)).resolves.toEqual({ ok: true, version: 3, state });

    const legacy = await decodeWatchlistToken(HISTORICAL_CATALOG_V2_TOKEN);
    expect(legacy).toMatchObject({
      ok: true,
      version: 2,
      state: { direct: [{ alertFreeze: false, overrideFreeze: false }] },
    });

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
        alertFreeze: Boolean(index & 32),
        overrideDews: Boolean(index & 32),
        overrideDepeg: Boolean(index & 64),
        overrideSafety: Boolean(index & 128),
        overrideLaunch: Boolean(index & 256),
        overrideReserve: Boolean(index & 1) !== Boolean(index & 32),
        overrideFreeze: Boolean(index & 64),
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
    const token = await encodeWatchlistTokenV3(state);
    expect(token).toMatch(/^pw3\./);
    expect(token.length).toBeLessThanOrEqual(MAX_WATCHLIST_TOKEN_CHARS);
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT - `<pre>${token}</pre>`.length).toBeGreaterThanOrEqual(80);
    expect(4096 - `/import ${token}`.length).toBeGreaterThanOrEqual(175);
    const decoded = await decodeWatchlistToken(token);
    expect(decoded).toEqual({
      ok: true,
      version: 3,
      state: {
        ...state,
        direct: [...state.direct].sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId)),
        presets: [...state.presets].sort((a, b) => a.presetId.localeCompare(b.presetId)),
      },
    });
  });

  it("rejects altered v2 payloads through the corruption/tamper digest", async () => {
    const token = HISTORICAL_CATALOG_V2_TOKEN;
    const parts = token.split(".");
    const payload = parts[1];
    const replacement = payload[0] === "A" ? "B" : "A";
    const altered = `${parts[0]}.${replacement}${payload.slice(1)}.${parts[2]}`;
    await expect(decodeWatchlistToken(altered)).resolves.toEqual({ ok: false, error: "integrity" });
  });

  it("rejects corrupt pw3 envelopes without treating them as legacy payloads", async () => {
    await expect(decodeWatchlistToken("pw3.not-base64.aaaaaaaaaaaaaaaa")).resolves.toEqual({
      ok: false,
      error: "integrity",
    });
    await expect(decodeWatchlistToken("pw3.aaaa.aaaaaaaaaaaaaaaa")).resolves.toEqual({
      ok: false,
      error: "integrity",
    });
  });

  it("rejects signed envelopes whose compressed payload cannot be decoded", async () => {
    const malformedCompressedPayload = new Uint8Array([0x01, 0x02, 0x03]);

    await expect(decodeWatchlistToken(await signedEnvelope("pw2", malformedCompressedPayload))).resolves.toEqual({
      ok: false,
      error: "malformed",
    });
    await expect(decodeWatchlistToken(await signedEnvelope("pw3", malformedCompressedPayload))).resolves.toEqual({
      ok: false,
      error: "malformed",
    });
  });

  it("rejects empty, malformed, unsupported, and oversized inputs", async () => {
    await expect(decodeWatchlistToken("   ")).resolves.toEqual({ ok: false, error: "empty" });
    await expect(decodeWatchlistToken("!!!not-base64!!!")).resolves.toEqual({ ok: false, error: "malformed" });
    await expect(decodeWatchlistToken(base64url("not json at all"))).resolves.toEqual({
      ok: false,
      error: "malformed",
    });
    await expect(
      decodeWatchlistToken(base64url(JSON.stringify({ v: 3, c: ["usdc-circle"], t: [], p: [] }))),
    ).resolves.toEqual({
      ok: false,
      error: "unsupported-version",
    });
    await expect(
      decodeWatchlistToken(`pw2.${"A".repeat(MAX_WATCHLIST_TOKEN_CHARS)}.AAAAAAAAAAAAAAAA`),
    ).resolves.toEqual({
      ok: false,
      error: "too-large",
    });
  });

  it("retains the historical 4000-character v1 read boundary", async () => {
    const accepted = historicalV1Token({ coinIds: ["x".repeat(2_960)], alertTypes: ["dews"], presetIds: [] });
    expect(accepted.length).toBeGreaterThan(MAX_WATCHLIST_TOKEN_CHARS);
    expect(accepted.length).toBeLessThanOrEqual(4000);
    const decoded = await decodeWatchlistToken(accepted);
    expect(decoded.ok && decoded.version === 1 ? decoded.state.coinIds[0]?.length : 0).toBe(2_960);

    const rejected = historicalV1Token({ coinIds: ["x".repeat(3_000)], alertTypes: ["dews"], presetIds: [] });
    expect(rejected.length).toBeGreaterThan(4000);
    await expect(decodeWatchlistToken(rejected)).resolves.toEqual({ ok: false, error: "too-large" });
  });
});
