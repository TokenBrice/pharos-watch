import { describe, expect, it } from "vitest";
import { summarizeDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import { describeDexVolume } from "../dex-volume-display";

describe("describeDexVolume", () => {
  it("floors the coverage share so just under the rating floor never reads as 50%", () => {
    const asOfSec = 1_800_000_000;
    const { availability } = summarizeDexVolumeWindow(
      [
        { volumeUsd: 1_000, observedAtSec: asOfSec - 60, tvlUsd: 4_996 },
        { volumeUsd: null, observedAtSec: null, tvlUsd: 5_004 },
      ],
      "24h",
      { asOfSec, maxObservationAgeSec: 72 * 3600 },
    );
    expect(describeDexVolume(null, availability).title).toContain("over pools holding 49% of retained TVL");
  });
});
