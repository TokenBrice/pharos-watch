import { describe, expect, it } from "vitest";
import {
  formatCoinPayload,
  formatCoveragePayload,
  formatWhyPayload,
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

  it("formats parametric payloads", () => {
    expect(formatCoinPayload("usdc-circle")).toBe("coin_usdc-circle");
    expect(formatWhyPayload("usdc-circle")).toBe("why_usdc-circle");
    expect(formatCoveragePayload("usdc-circle")).toBe("coverage_usdc-circle");
  });

  it("rejects empty insight ids and malformed payloads", () => {
    expect(parseMiniAppPayload("why_")).toBeNull();
    expect(parseMiniAppPayload("coverage_")).toBeNull();
    expect(parseMiniAppPayload("why_usdc circle")).toBeNull();
  });
});
