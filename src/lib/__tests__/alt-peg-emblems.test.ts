import { describe, expect, it } from "vitest";
import {
  buildPegEmblemClusters,
  PEG_ANCHORS,
} from "@/lib/alt-peg-emblems";
import { PEG_COUNTRY_MAP } from "@/lib/alt-peg-geography";

describe("buildPegEmblemClusters", () => {
  const clusters = buildPegEmblemClusters();

  it("returns one cluster per covered peg with at least one tracked stablecoin", () => {
    const coveredPegs = Object.keys(PEG_COUNTRY_MAP).filter((peg) =>
      PEG_ANCHORS[peg],
    );
    // Every covered peg should have at least one stablecoin in the fixture;
    // if that changes, this assertion will correctly fail and prompt an update.
    expect(clusters.length).toBe(coveredPegs.length);
  });

  it("every cluster has at least one emblem", () => {
    for (const cluster of clusters) {
      expect(cluster.emblems.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("EUR cluster contains at least 10 emblems", () => {
    const eur = clusters.find((c) => c.peg === "EUR");
    expect(eur).toBeDefined();
    expect(eur!.emblems.length).toBeGreaterThanOrEqual(10);
  });

  it("every emblem has a non-empty logoSrc string", () => {
    for (const cluster of clusters) {
      for (const emblem of cluster.emblems) {
        expect(typeof emblem.logoSrc).toBe("string");
        expect(emblem.logoSrc.length).toBeGreaterThan(0);
      }
    }
  });

  it("emblems within each cluster are sorted alphabetically by symbol", () => {
    for (const cluster of clusters) {
      const symbols = cluster.emblems.map((e) => e.symbol);
      const sorted = [...symbols].sort((a, b) => a.localeCompare(b));
      expect(symbols).toEqual(sorted);
    }
  });
});
