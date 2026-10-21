import { describe, expect, it } from "vitest";
import {
  miniAppPayloadIntent,
  parseMiniAppPayload,
} from "../telegram-mini-app-payloads";

describe("telegram mini app payloads", () => {
  it("parses coin insight payloads", () => {
    expect(parseMiniAppPayload("why_usdc-circle")).toEqual({ kind: "why", coinId: "usdc-circle" });
    expect(parseMiniAppPayload("coverage_dai-makerdao")).toEqual({ kind: "coverage", coinId: "dai-makerdao" });
    expect(miniAppPayloadIntent({ kind: "why", coinId: "usdc-circle" })).toBe("why");
    expect(miniAppPayloadIntent({ kind: "coverage", coinId: "usdc-circle" })).toBe("coverage");
  });

  it("maps only catalog-issued adoption tokens to their Mini App destinations", () => {
    expect(parseMiniAppPayload("pw1_landing_miniapp_home")).toEqual({
      kind: "adoption",
      destination: "miniapp_home",
    });
    expect(miniAppPayloadIntent(parseMiniAppPayload("pw1_landing_miniapp_watchlist")!)).toBe("watchlist");
    expect(parseMiniAppPayload("pw1_landing_unknown")).toBeNull();
    expect(parseMiniAppPayload("pw1_landing_hero")).toBeNull();
  });

  it("rejects retired recap launch tokens while retaining timezone and watchlist routes", () => {
    expect(parseMiniAppPayload("recap_settings")).toBeNull();
    expect(parseMiniAppPayload("recap_watchlist")).toBeNull();
    expect(miniAppPayloadIntent(parseMiniAppPayload("quiet-hours")!)).toBe("quiet-hours");
    expect(miniAppPayloadIntent(parseMiniAppPayload("watchlist")!)).toBe("watchlist");
  });

  it("routes the onboarding setup target", () => {
    expect(parseMiniAppPayload("setup")).toEqual({ kind: "named", name: "setup" });
    expect(miniAppPayloadIntent(parseMiniAppPayload("SETUP")!)).toBe("setup");
  });

  it("rejects empty insight ids and malformed payloads", () => {
    expect(parseMiniAppPayload("why_")).toBeNull();
    expect(parseMiniAppPayload("coverage_")).toBeNull();
    expect(parseMiniAppPayload("why_usdc circle")).toBeNull();
  });
});
