import type { EthCallJournal, PinnedBlock } from "./core";
import { measureFxProtocol } from "./families/fx-protocol";
import { measureGho } from "./families/gho";
import { measureLiquityV1 } from "./families/liquity-v1";
import { measureLiquityV2 } from "./families/liquity-v2";
import { measureEnumeratedLiquityV2 } from "./families/liquity-v2-enumerated";
import { measureMentoConversion } from "./families/mento-conversion";
import { measureResupply } from "./families/resupply";
import { measureWrapperMechanism } from "./families/wrapper";
import { measureYamato } from "./families/yamato";
import type { CdpMeasurementTarget } from "./targets";

export async function measureConfiguredTarget(
  caller: EthCallJournal,
  target: CdpMeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
) {
  switch (target.family) {
    case "liquity-v1":
      return measureLiquityV1(caller, target, block, rpcUrl);
    case "liquity-v2":
      return measureLiquityV2(caller, target, block, rpcUrl);
    case "liquity-v2-enumerated-v1":
      return measureEnumeratedLiquityV2(caller, target, block, rpcUrl);
    case "mento-conversion-evidence-v1":
      return measureMentoConversion(caller, target, block, rpcUrl);
    case "yamato-system-v1":
      return measureYamato(caller, target, block, rpcUrl);
    case "gho-facilitator-evidence-v1":
      return measureGho(caller, target, block, rpcUrl);
    case "fx-protocol-v1":
      return measureFxProtocol(caller, target, block, rpcUrl);
    case "wrapper-mechanism-v1":
      return measureWrapperMechanism(caller, target, block, rpcUrl);
    case "resupply-pairs-v1":
      return measureResupply(caller, target, block, rpcUrl);
  }
}
