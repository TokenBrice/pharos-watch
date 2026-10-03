import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMatrixdockStbt } from "../matrixdock-stbt";
const body = readFileSync(new URL("./fixtures/matrixdock-stbt.html", import.meta.url), "utf8");
describe("Matrixdock STBT issuer asset census", () => {
  it("uses live asset values without inventing an observation clock or custody rights", () => {
    const result = parseMatrixdockStbt(body);
    expect(result.slices.find((r) => r.sourceKey?.endsWith("asset_nav_t_bill"))?.pct).toBeCloseTo(22414696.63 / 23790631.16 * 100, 6);
    expect(result.metadata).toMatchObject({ freshnessMode: "unverified", supplyTokens: 23595622.754750902935317681 });
    expect(result.metadata).not.toHaveProperty("sourceTimestamp");
    expect(result.metadata).not.toHaveProperty("immediateRedeemableUsd");
  });
  it("rejects changed balances that do not reconcile and missing native identity", () => {
    expect(() => parseMatrixdockStbt(body.replace("22414696.63", "12414696.63"))).toThrow(/unreconciled/);
    expect(() => parseMatrixdockStbt(body.replace("0x530824da86689c9c17cdc2871ff29b058345b44a", "0x0000000000000000000000000000000000000000"))).toThrow(/identity/);
  });
  it("fails closed on new buckets, ambiguous records and truncated payloads", () => {
    expect(() => parseMatrixdockStbt(body.replace("asset_nav_repo", "asset_nav_new"))).toThrow(/unreviewed/);
    expect(() => parseMatrixdockStbt(body + body)).toThrow(/ambiguous/);
    expect(() => parseMatrixdockStbt(body.replace("stbt_total_supply", "unknown_supply"))).toThrow(/missing/);
  });
});
