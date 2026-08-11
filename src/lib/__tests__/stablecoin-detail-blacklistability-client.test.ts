// src/lib/__tests__/stablecoin-detail-blacklistability-client.test.ts
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { projectBlacklistabilityClientSummary } from "../stablecoin-detail-blacklistability-client";

function coinWith(overrides: Record<string, unknown>): StablecoinMeta {
  return { id: "test-coin", ...overrides } as unknown as StablecoinMeta;
}

const FREEZABLE_REVIEW = {
  reviewedStatus: true,
  sources: [{ label: "Verified USDT source", url: "https://example.com/usdt" }],
  evidence: "The canonical implementation exposes owner-only addBlackList and destroyBlackFunds.",
  reviewer: "Codex C01 control/access review",
  reviewedAt: "2026-08-08",
};

describe("projectBlacklistabilityClientSummary", () => {
  it("returns null without a review", () => {
    expect(projectBlacklistabilityClientSummary(coinWith({}))).toBeNull();
  });

  it("returns null for a malformed review object", () => {
    expect(projectBlacklistabilityClientSummary(coinWith({ blacklistabilityReview: { sentinel: true } }))).toBeNull();
    expect(projectBlacklistabilityClientSummary(coinWith({ blacklistabilityReview: "freezable" }))).toBeNull();
  });

  it("returns null when the status is out of the reviewed vocabulary", () => {
    expect(
      projectBlacklistabilityClientSummary(
        coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, reviewedStatus: "maybe" } }),
      ),
    ).toBeNull();
  });

  it("returns null without evidence prose", () => {
    expect(
      projectBlacklistabilityClientSummary(
        coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, evidence: "   " } }),
      ),
    ).toBeNull();
  });

  it("projects a freezable review with its sources and reviewed date", () => {
    const summary = projectBlacklistabilityClientSummary(coinWith({ blacklistabilityReview: FREEZABLE_REVIEW }));
    expect(summary).not.toBeNull();
    expect(summary!.status).toBe("freezable");
    expect(summary!.statusLabel).toBe("Freezable");
    expect(summary!.statusToneClass).toContain("amber");
    expect(summary!.statusNote).toContain("can freeze or seize");
    expect(summary!.evidence).toBe(FREEZABLE_REVIEW.evidence);
    expect(summary!.basisLabel).toBe("Sourced review");
    expect(summary!.sourceFreeRationale).toBeNull();
    expect(summary!.upstreamLabel).toBeNull();
    expect(summary!.sources).toEqual([{ label: "Verified USDT source", url: "https://example.com/usdt" }]);
    expect(summary!.reviewedAt).toBe("2026-08-08");
  });

  it("projects a not-freezable review with the emerald tone", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, reviewedStatus: false } }),
    );
    expect(summary!.status).toBe("not-freezable");
    expect(summary!.statusLabel).toBe("Not freezable");
    expect(summary!.statusToneClass).toContain("emerald");
    expect(summary!.statusNote).toContain("no issuer freeze");
  });

  it("projects a possible review with the amber tone", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, reviewedStatus: "possible" } }),
    );
    expect(summary!.status).toBe("possible");
    expect(summary!.statusLabel).toBe("Possible");
    expect(summary!.statusToneClass).toContain("amber");
    expect(summary!.statusNote).toContain("plausible");
  });

  it("names the upstream coin for an inherited review when the registry resolves it", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, reviewedStatus: "inherited" }, variantOf: "usdc-circle" }),
      new Map([["usdc-circle", { id: "usdc-circle", name: "USD Coin" } as unknown as StablecoinMeta]]),
    );
    expect(summary!.status).toBe("inherited");
    expect(summary!.statusToneClass).toContain("blue");
    expect(summary!.upstreamLabel).toBe("USD Coin");
    expect(summary!.statusNote).toContain("USD Coin");
  });

  it("falls back to the upstream id when no registry entry is available", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, reviewedStatus: "inherited" }, variantOf: "usdc-circle" }),
    );
    expect(summary!.upstreamLabel).toBe("usdc-circle");
    expect(summary!.statusNote).toContain("usdc-circle");
  });

  it("reads the upstream from the mint-authority review when there is no variant edge", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({
        blacklistabilityReview: { ...FREEZABLE_REVIEW, reviewedStatus: "inherited" },
        mintAuthority: { inheritedFrom: "usdt-tether" },
      }),
      new Map([["usdt-tether", { id: "usdt-tether", name: "Tether" } as unknown as StablecoinMeta]]),
    );
    expect(summary!.upstreamLabel).toBe("Tether");
  });

  it("keeps the upstream null for an inherited review with no named parent", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, reviewedStatus: "inherited" } }),
    );
    expect(summary!.upstreamLabel).toBeNull();
    expect(summary!.statusNote).toContain("upstream in the assets");
  });

  it("does not resolve an upstream for a non-inherited status", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({ blacklistabilityReview: FREEZABLE_REVIEW, variantOf: "usdc-circle" }),
    );
    expect(summary!.upstreamLabel).toBeNull();
  });

  it("reports a source-free review as rationale-only", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({
        blacklistabilityReview: {
          reviewedStatus: true,
          sourceFreeRationale: "Resolved from Pharos stablecoin metadata; no manual override source is attached.",
          evidence: "Centralized bank-issued fiat-referenced payment token under CBUAE oversight.",
          reviewer: "Pharos pre-launch addition",
          reviewedAt: "2026-06-13",
        },
      }),
    );
    expect(summary!.basisLabel).toBe("Rationale only");
    expect(summary!.sourceFreeRationale).toContain("no manual override source");
    expect(summary!.sources).toEqual([]);
  });

  it("reports a review with neither sources nor a rationale as unsourced", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({ blacklistabilityReview: { ...FREEZABLE_REVIEW, sources: undefined } }),
    );
    expect(summary!.basisLabel).toBe("Unsourced");
  });

  it("drops malformed source entries and a non-string reviewed date", () => {
    const summary = projectBlacklistabilityClientSummary(
      coinWith({
        blacklistabilityReview: {
          ...FREEZABLE_REVIEW,
          sources: [{ label: "No url" }, "https://example.com/bare", { label: "Kept", url: "https://example.com/kept" }],
          reviewedAt: 20260808,
        },
      }),
    );
    expect(summary!.sources).toEqual([{ label: "Kept", url: "https://example.com/kept" }]);
    expect(summary!.reviewedAt).toBeNull();
  });
});
