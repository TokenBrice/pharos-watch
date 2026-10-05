import { describe, expect, it } from "vitest";
import { ContractDeploymentSchema } from "../../../types/stablecoin-meta-schemas";
import { CHAIN_META } from "../../../types/chain-identity";
import { buildExplorerUrl } from "../../explorer";
import { isFixedDecimalDeployment } from "../../deployment-amounts";
import { canonicalExitRouteScopedKey } from "../../../types/exit-route-identity";
import { StablecoinMetaSourceAssetSchema, StablecoinMetaAssetSchema } from "../schema";
import { getContractDeploymentIssues } from "../../../../scripts/ci/check-stablecoin-data";
import { validateMintBridgeOwnership } from "../mint-bridge-ownership";
import coin from "../../../data/stablecoins/coins/usdx-kava.json";
import mint from "../../../data/stablecoins/domains/mint-authority/usdx-kava.json";
import risk from "../../../data/stablecoins/domains/risk-review/usdx-kava.json";

const native = { kind: "native-denom", chain: "kava", address: "usdx", decimals: 6 };
describe("typed native bank deployment identities", () => {
  it("admits Kava's native rail without reclassifying its EVM chain", () => {
    expect(ContractDeploymentSchema.parse(native)).toEqual(native);
    expect(CHAIN_META.kava.type).toBe("evm");
    expect(CHAIN_META.kava.evmChainId).toBe(2222);
    const parsed = StablecoinMetaSourceAssetSchema.parse({ ...coin, contracts: [native] });
    expect(getContractDeploymentIssues(parsed)).toEqual([]);
    const untyped = StablecoinMetaSourceAssetSchema.parse({ ...coin, contracts: [{ chain: "kava", address: "usdx", decimals: 6 }] });
    expect(getContractDeploymentIssues(untyped)).toEqual([expect.stringContaining("invalid EVM address")]);
  });
  it.each([
    { ...native, chain: "ethereum" }, { ...native, address: `0x${"a".repeat(40)}` },
    { ...native, address: "us dx" }, { ...native, address: "" }, { ...native, decimals: -1 },
    { ...native, amountEncoding: { kind: "xrpl-issued-currency" } },
  ])("rejects an invalid native identity %j", row => {
    expect(ContractDeploymentSchema.safeParse(row).success).toBe(false);
  });
  it("keeps known native identity when its exponent is unknown without admitting fixed-scale amounts", () => {
    const identity = ContractDeploymentSchema.parse({ ...native, decimals: null });
    expect(identity.decimals).toBeNull();
    expect(isFixedDecimalDeployment(identity)).toBe(false);
    expect(getContractDeploymentIssues(StablecoinMetaSourceAssetSchema.parse({ ...coin, contracts: [identity] }))).toEqual([]);
  });
  it("supports explicit fixed-decimal encoding on native bank units", () => {
    const identity = ContractDeploymentSchema.parse({ ...native, amountEncoding: { kind: "fixed-decimal" } });
    expect(identity.amountEncoding).toEqual({ kind: "fixed-decimal" });
    expect(isFixedDecimalDeployment(identity)).toBe(true);
  });
  it("preserves case-sensitive denoms while normalizing genuine Kava EVM addresses", () => {
    expect(canonicalExitRouteScopedKey("kava", "factory/Issuer/USDX")).toBe("kava:factory/Issuer/USDX");
    expect(canonicalExitRouteScopedKey("kava", `0x${"A".repeat(40)}`)).toBe(`kava:0x${"a".repeat(40)}`);
  });
  it("binds native controls only to native issuance and keeps the receipt distinct", () => {
    const parsed = StablecoinMetaAssetSchema.parse({ ...coin, ...mint, ...risk });
    expect(buildExplorerUrl({ chainKey: "kava", entityType: "contract", value: "usdx", deploymentKind: "native-denom" })).toBeNull();
    expect(getContractDeploymentIssues(parsed)).toEqual([]);
    expect(validateMintBridgeOwnership(parsed)).toEqual([]);
    expect(parsed.contracts!.map(row => `${row.chain}:${row.address}`)).toEqual([
      "kava:usdx", "osmosis:ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE",
    ]);
    expect(parsed.mintAuthority!.review.noLocalIssuance).toBeUndefined();
    expect(parsed.mintAuthority!.controls!.every(control => control.deploymentRefs?.join() === "kava:usdx")).toBe(true);
  });
});
