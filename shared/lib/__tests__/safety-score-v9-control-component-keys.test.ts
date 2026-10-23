import { describe, expect, it } from "vitest";
import {
  isV9BridgeRouteComponentFor,
  isV9DeploymentControlComponentKey,
  v9BridgeMintComponentKey,
  v9BridgeMintControlKey,
  v9BridgeRouteComponentKey,
  v9BridgeRouteDeploymentKey,
  v9ControlChainLabel,
  v9DeploymentMintComponentKey,
} from "../safety-score-v9/control-component-keys";

describe("V9 control component keys", () => {
  // Sui coin types put `::` inside the deployment id, so colon splitting
  // cannot recover either half; the shared control key can.
  const sui = "sui:0xdba3::usdc::USDC";
  const controlKey = "bridge-meta:usdc-circle:52b72ec3cb21ad6fcb03";

  it("joins a bridge route to its token-mint twin through the full control key", () => {
    const route = v9BridgeRouteComponentKey(sui, controlKey);
    const mint = v9BridgeMintComponentKey(controlKey);
    expect(v9BridgeMintControlKey(mint)).toBe(controlKey);
    expect(isV9BridgeRouteComponentFor(route, controlKey)).toBe(true);
    expect(v9BridgeRouteDeploymentKey(route, controlKey)).toBe(sui);
    expect(isV9BridgeRouteComponentFor(route, "bridge-meta:usdc-circle:other")).toBe(false);
    expect(v9BridgeRouteDeploymentKey(`bridge:${controlKey}`, controlKey)).toBeNull();
  });

  it("separates deployment-level inputs from asset-level ones", () => {
    expect(isV9DeploymentControlComponentKey(v9BridgeRouteComponentKey(sui, controlKey))).toBe(true);
    expect(isV9DeploymentControlComponentKey(v9BridgeMintComponentKey(controlKey))).toBe(true);
    expect(isV9DeploymentControlComponentKey(v9DeploymentMintComponentKey(["mint-meta:a:1", "mint-meta:a:2"]))).toBe(true);
    for (const key of ["mint", "mint:binding", "mint:upgrade", "oracle", "bridge:native", "bridge:unverified"]) {
      expect(isV9DeploymentControlComponentKey(key)).toBe(false);
    }
    expect(v9BridgeMintControlKey("mint")).toBeNull();
  });

  it("names only registered chains", () => {
    expect(v9ControlChainLabel("xlayer:0x86a2")).toBe("X Layer");
    expect(v9ControlChainLabel(sui)).toBe("Sui");
    for (const key of ["asset:usdc-circle", "issuer-backend:circle", "representation-group:x", "ambiguous-chain:x", "mint"]) {
      expect(v9ControlChainLabel(key)).toBeNull();
    }
  });
});
