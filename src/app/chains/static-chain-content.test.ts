import { describe, expect, it } from "vitest";
import {
  getChainDirectoryEntries,
  getChainTrackedDeploymentCount,
} from "./static-chain-content";

describe("getChainDirectoryEntries", () => {
  // The directory now derives per-chain deployment counts from a single
  // contract-count Map pass; pin that it matches the per-chain helper so the
  // optimization can't silently diverge. [audit S-020]
  it("reports deployment counts that match getChainTrackedDeploymentCount per chain", () => {
    const entries = getChainDirectoryEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.deploymentCount).toBe(getChainTrackedDeploymentCount(entry.id));
    }
  });

  it("returns entries sorted by name", () => {
    const names = getChainDirectoryEntries().map((entry) => entry.name);
    const sorted = [...names].sort((left, right) => left.localeCompare(right));
    expect(names).toEqual(sorted);
  });
});
