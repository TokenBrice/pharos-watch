import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptFrntLedgerlens } from "../frnt-ledgerlens";

type WireNode = { t: number; s?: unknown; a?: WireNode[]; p?: { k: string[]; v: WireNode[] } };
const capture = JSON.parse(readFileSync(new URL("./fixtures/frnt-ledgerlens.txt", import.meta.url), "utf8").replace(/<!--[^]*?-->\s*/g, "")) as WireNode;
function field(node: WireNode, key: string): WireNode {
  const index = node.p?.k.indexOf(key) ?? -1;
  if (index < 0 || !node.p) throw new Error(`missing fixture field ${key}`);
  return node.p.v[index];
}
function snapshot(payload: WireNode): WireNode {
  return field(field(payload, "result"), "lastActiveSnapshot");
}
function reserve(payload: WireNode): WireNode {
  return field(snapshot(payload), "balances").a![1];
}
function buckets(payload: WireNode): WireNode {
  return field(field(reserve(payload), "breakdown"), "byType");
}

describe("frnt-ledgerlens", () => {
  it("keeps gross composition distinct from net holder coverage and source time", () => {
    const result = adaptFrntLedgerlens(capture);
    const weights = Object.fromEntries(result.slices.map(({ sourceKey, pct }) => [sourceKey, pct]));
    expect(weights["frnt-ledgerlens:fbo:treasury-bills"]).toBeCloseTo(355109.96 / 1006340.74 * 100, 8);
    expect(weights["frnt-ledgerlens:fbo:repurchase-agreements"]).toBeCloseTo(600000 / 1006340.74 * 100, 8);
    expect(weights["frnt-ledgerlens:fbo:cash"]).toBeCloseTo(51230.78 / 1006340.74 * 100, 8);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.parse("2026-10-02T12:00:44.629Z") / 1000,
      freshnessMode: "verified", totalReserveUsd: 968051.85, supplyUsd: 968051.849913,
      details: { grossFboAssetsUsd: 1006340.74, administrativePayableUsd: 38288.89, liquidityFundUsd: 0, runtimeAssuranceVerification: false, netBackingCompositionAttribution: "withheld", liabilityChainCount: 8 },
    });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 8);
    expect(result.metadata).not.toHaveProperty("redemption");
  });

  it("publishes a measured net-reserve shortfall without allocating the administrative haircut to cash", () => {
    const payload = structuredClone(capture);
    const summary = field(snapshot(payload), "summary");
    field(summary, "fboTrustDueAdminAccount").s = 50000;
    field(summary, "trustAccountNetFmv").s = 956340.74;
    field(summary, "totalHedge").s = 956340.74;
    const result = adaptFrntLedgerlens(payload);
    expect(result.slices.find((slice) => slice.sourceKey === "frnt-ledgerlens:fbo:cash")?.pct).toBeCloseTo(51230.78 / 1006340.74 * 100, 8);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(956340.74 / 968051.849913, 10);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
  });

  it.each([
    ["missing bucket", (p: WireNode) => { const b = buckets(p); b.p!.k.pop(); b.p!.v.pop(); }],
    ["new bucket", (p: WireNode) => { const b = buckets(p); b.p!.k.push("OTHER"); b.p!.v.push(structuredClone(b.p!.v[0])); }],
    ["unreadable balance", (p: WireNode) => { field(field(buckets(p), "CASH"), "rawValue").s = ""; }],
    ["negative balance", (p: WireNode) => { field(field(buckets(p), "CASH"), "rawValue").s = "-1"; }],
    ["inconsistent bucket", (p: WireNode) => { field(field(buckets(p), "CASH"), "rawValue").s = "51231.78"; }],
    ["missing item", (p: WireNode) => { field(field(reserve(p), "breakdown"), "items").a!.pop(); }],
    ["new reserve account", (p: WireNode) => { field(field(field(reserve(p), "breakdown"), "items").a![0], "account").s = "LIQUIDITY_FUND"; }],
    ["unreconciled payable", (p: WireNode) => { field(field(snapshot(p), "summary"), "fboTrustDueAdminAccount").s = 0; }],
    ["new liquidity scope", (p: WireNode) => { field(field(snapshot(p), "summary"), "liquidityAccountNetFmv").s = 1; }],
    ["missing chain liability", (p: WireNode) => { field(field(snapshot(p), "balances").a![0], "breakdown").a!.pop(); }],
    ["wrong token identity", (p: WireNode) => { field(field(field(snapshot(p), "balances").a![0], "breakdown").a![0], "address").s = "0x0000000000000000000000000000000000000001"; }],
    ["duplicate chain", (p: WireNode) => { const b = field(field(snapshot(p), "balances").a![0], "breakdown"); b.a![1] = structuredClone(b.a![0]); }],
    ["invalid source date", (p: WireNode) => { field(snapshot(p), "createdAt").s = "today"; }],
    ["unsupported wire reference", (p: WireNode) => { field(snapshot(p), "summary").t = 11; }],
    ["ambiguous wire property", (p: WireNode) => { const s = snapshot(p); s.p!.k.push("summary"); s.p!.v.push(field(s, "summary")); }],
  ] as const)("fails closed on %s", (_label, mutate) => {
    const payload = structuredClone(capture);
    mutate(payload);
    expect(() => adaptFrntLedgerlens(payload)).toThrow();
  });
});
