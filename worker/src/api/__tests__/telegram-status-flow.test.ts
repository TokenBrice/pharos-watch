import { describe, it, expect } from "vitest";

import { buildStatusMessage } from "../telegram-webhook-messages";
import type { StatusForCoin } from "../telegram-webhook-status";

function baseStatus(overrides: Partial<StatusForCoin> = {}): StatusForCoin {
  return {
    stablecoinId: "usdc-circle",
    priceUsd: 1,
    priceUpdatedAt: Math.floor(Date.now() / 1000),
    supplyUsd: null,
    stablecoinsUpdatedAt: null,
    dews: null,
    safety: null,
    safetyUnavailableReason: null,
    liquidity: null,
    yield: null,
    flow: null,
    depeg: { status: "stable" },
    ...overrides,
  };
}

describe("buildStatusMessage 24h mint/burn flow line (C122)", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it("renders a signed Flow 24h line when flow is present", () => {
    const msg = buildStatusMessage(
      "USDC",
      baseStatus({ flow: { netFlowUsd: 12_300_000, updatedAt: nowSec, stale: false } }),
    );
    expect(msg).toContain("Flow 24h: +$12");
  });

  it("renders $0 for zero net flow (tracked coin, no events)", () => {
    const msg = buildStatusMessage("USDC", baseStatus({ flow: { netFlowUsd: 0, updatedAt: nowSec, stale: false } }));
    expect(msg).toContain("Flow 24h: $0");
  });

  it("renders a negative net flow with a minus sign", () => {
    const msg = buildStatusMessage(
      "USDC",
      baseStatus({ flow: { netFlowUsd: -4_000_000, updatedAt: nowSec, stale: false } }),
    );
    expect(msg).toContain("Flow 24h: -$4");
  });

  it("omits the line for untracked coins (flow null), without an n/a placeholder", () => {
    const msg = buildStatusMessage("USDC", baseStatus({ flow: null }));
    expect(msg).not.toContain("Flow 24h");
  });
});

describe("buildStatusMessage canonical safety provenance", () => {
  it("renders model provenance and explicit canonical unavailability", () => {
    const source = baseStatus({
      safety: {
        grade: "A",
        score: 90,
        model: "v8",
        methodologyVersion: "v8.17",
        publicationGenerationId: "report-cards:v8.17:123",
        publishedAt: Math.floor(Date.now() / 1000),
        recordedAt: Math.floor(Date.now() / 1000),
      },
    });
    expect(buildStatusMessage("USDC", source)).toContain("Safety: A (90) [V8 v8.17]");
    expect(
      buildStatusMessage("USDC", baseStatus({ safetyUnavailableReason: "canonical-snapshot-unavailable" })),
    ).toContain("Safety: temporarily unavailable");
  });
});

describe("buildStatusMessage Telegram HTML escaping", () => {
  it("escapes provider-controlled yield source text", () => {
    const msg = buildStatusMessage(
      "USDC",
      baseStatus({
        yield: {
          currentApy: 4.8,
          apy30d: 4.2,
          source: 'Morpho: Safe Vault <a href="https://attacker.example/phish">CLAIM</a> & <b>verified</b>',
          pharosYieldScore: 42,
          updatedAt: Math.floor(Date.now() / 1000),
        },
      }),
    );

    expect(msg).toContain(
      "Morpho: Safe Vault &lt;a href=&quot;https://attacker.example/phish&quot;&gt;CLAIM&lt;/a&gt; &amp; &lt;b&gt;verified&lt;/b&gt;",
    );
    expect(msg).not.toContain('<a href="https://attacker.example/phish">');
    expect(msg).not.toContain("<b>verified</b>");
  });
});
