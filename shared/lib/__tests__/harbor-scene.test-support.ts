import type { HarborSceneInput } from "../harbor-scene";
import live from "./fixtures/harbor-chains-2026-10-12.json";

/** Live `/api/chains` payload of 2026-10-12, trimmed to the fields the harbor reads. */
export const HARBOR_LIVE = live as unknown as HarborSceneInput;

/** The same world with every supply figure multiplied (growth fixtures). */
export function scaleHarborInput(input: HarborSceneInput, factor: number): HarborSceneInput {
  return {
    ...input,
    globalTotalUsd: input.globalTotalUsd * factor,
    chainAttributedTotalUsd: input.chainAttributedTotalUsd * factor,
    unattributedTotalUsd: input.unattributedTotalUsd * factor,
    chains: input.chains.map((c) => ({
      ...c,
      totalUsd: c.totalUsd * factor,
      topStablecoins: c.topStablecoins.map((row) => ({ ...row, supplyUsd: row.supplyUsd * factor })),
    })),
  };
}
