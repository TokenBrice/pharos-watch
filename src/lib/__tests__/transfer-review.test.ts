import { describe, expect, it } from "vitest";
import { buildTransferReviewView } from "../transfer-review";

describe("buildTransferReviewView", () => {
  it("carries the per-deployment finding behind the scored access enum", () => {
    const view = buildTransferReviewView("bold-liquity");
    expect(view).not.toBeNull();
    expect(view?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const deployment = view?.deployments[0];
    expect(deployment?.chainName).toBe("Ethereum");
    expect(deployment?.postureLabel).toBe("Permissionless");
    expect(deployment?.scopeLabel).toBe("Canonical");
    expect(deployment?.evidence.length).toBeGreaterThan(0);
    expect(deployment?.sources.every((source) => source.url.startsWith("https://"))).toBe(true);
  });

  it("flags an asset whose posture is not uniform across chains", () => {
    // These four are the only reviewed assets where a bridged deployment does
    // not match its canonical one, which is exactly what the panel's single
    // aggregate row hides.
    for (const assetId of ["mim-abracadabra", "weusd-picwe", "pht-pht", "gldt-gold-dao"]) {
      expect(buildTransferReviewView(assetId)?.mixedPosture).toBe(true);
    }
  });

  it("reports a uniform posture as unmixed", () => {
    expect(buildTransferReviewView("bold-liquity")?.mixedPosture).toBe(false);
  });

  it("orders canonical deployments ahead of bridged copies", () => {
    const view = buildTransferReviewView("mim-abracadabra");
    const scopes = view?.deployments.map((deployment) => deployment.scope) ?? [];
    const firstBridged = scopes.findIndex((scope) => scope !== "canonical");
    if (firstBridged !== -1) {
      expect(scopes.slice(firstBridged).every((scope) => scope !== "canonical")).toBe(true);
    }
  });

  it("precomputes every label so the client never imports the overlay", () => {
    const view = buildTransferReviewView("bold-liquity");
    for (const deployment of view?.deployments ?? []) {
      expect(deployment.chainName).not.toBe("");
      expect(deployment.postureLabel).not.toBe("");
      expect(deployment.scopeLabel).not.toBe("");
    }
  });

  it("returns null for an asset with no transfer review", () => {
    expect(buildTransferReviewView("not-a-real-coin")).toBeNull();
  });
});
