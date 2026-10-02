import { describe, expect, it } from "vitest";
import base from "@shared/data/stablecoins/coins/usdc-circle.json";
import risk from "@shared/data/stablecoins/domains/risk-review/usdc-circle.json";
import mint from "@shared/data/stablecoins/domains/mint-authority/usdc-circle.json";
import { StablecoinMetaAssetSchema } from "@shared/lib/stablecoins/schema";
import { buildBridgeRouteCoverageAudit } from "../lib/bridge-route-coverage-audit";

const native = "0xb6ceceab302e2e4948951ee7843fc24e92933061";
const bridged = "0x74b7f16337b8972027f6196a17a631ac6de26d22";
const meta = StablecoinMetaAssetSchema.parse({ ...base, ...risk, ...mint });

describe("USDC X Layer deployment identity", () => {
  it("keeps exact native and third-party identities and native controls separate", () => {
    for (const [address, issuanceModel, routeClass] of [
      [native, "native-issuance", "native"],
      [bridged, "bridge-representation", "third-party"],
    ]) {
      expect(meta.contracts?.find((row) => row.chain === "xlayer" && row.address === address))
        .toEqual({ chain: "xlayer", address, decimals: 6 });
      expect(meta.bridgeRouteRisk?.routes?.find((row) => row.id === `xlayer:${address}`))
        .toMatchObject({ contractAddress: address, issuanceModel, routeClass });
    }
    const controls = meta.mintAuthority?.controls?.filter((row) => row.chain === "xlayer");
    expect(controls?.map((row) => [row.address, row.directMintAbility])).toEqual([
      ["0xa2a9f84222659d4e1639d38488e7024882fa90ff", "can-authorize"],
      ["0x88deee3d8bd65d0b73fef679eeddc7867c0d69e6", "can-authorize"],
      ["0x86a2b15f6ef67af32a6b7c43903cdecb1f540ec1", "upgrade-only"],
    ]);
    for (const control of controls ?? []) {
      expect(control.deploymentRefs).toEqual([`xlayer:${native}`]);
    }
    const audit = buildBridgeRouteCoverageAudit([meta], "2026-09-27T00:00:00.000Z");
    expect(audit.summary.incompleteRouteProfiles).toBe(0);
    expect(audit.summary.invalidEvidenceProfiles).toBe(0);
    expect(audit.summary.sameChainAmbiguityProfiles).toBe(1);
  });
});
