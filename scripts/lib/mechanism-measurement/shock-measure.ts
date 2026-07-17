import type { PinnedBlock } from "./core";
import { measureLiquityV1ShockCoverage } from "./families/liquity-v1-shock";
import { measureLiquityV2ShockCoverage } from "./families/liquity-v2-shock";
import type { ShockCallJournal } from "./shock-journal";
import type { ShockCoverageTarget } from "./shock-targets";

export async function measureConfiguredShockCoverageTarget(
  caller: ShockCallJournal,
  target: ShockCoverageTarget,
  block: PinnedBlock,
  rpcUrl: string,
) {
  switch (target.family) {
    case "liquity-v1-shock-v1":
      return measureLiquityV1ShockCoverage(caller, target, block, rpcUrl);
    case "liquity-v2-shock-v1":
      return measureLiquityV2ShockCoverage(caller, target, block, rpcUrl);
  }
}
