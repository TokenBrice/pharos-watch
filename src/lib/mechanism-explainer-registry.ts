import type { MechanismArchetype } from "@shared/types";
import type { ArchetypeContent } from "./mechanism-explainers/types";
import { metadata as fiatCash } from "./mechanism-explainers/fiat-cash.metadata";
import { metadata as tbill } from "./mechanism-explainers/tbill.metadata";
import { metadata as cdp } from "./mechanism-explainers/cdp.metadata";
import { metadata as syntheticDeltaNeutral } from "./mechanism-explainers/synthetic-delta-neutral.metadata";
import { metadata as algorithmic } from "./mechanism-explainers/algorithmic.metadata";
import { metadata as rwaCreditFund } from "./mechanism-explainers/rwa-credit-fund.metadata";
import { metadata as commodityClaim } from "./mechanism-explainers/commodity-claim.metadata";
import { metadata as ucitsTrsFund } from "./mechanism-explainers/ucits-trs-fund.metadata";
import { metadata as sharedReserve } from "./mechanism-explainers/shared-reserve.metadata";
import { metadata as protocolPosition } from "./mechanism-explainers/protocol-position.metadata";

export const MECHANISM_EXPLAINER_METADATA = {
  "fiat-cash": fiatCash,
  "tbill": tbill,
  "cdp": cdp,
  "synthetic-delta-neutral": syntheticDeltaNeutral,
  "algorithmic": algorithmic,
  "rwa-credit-fund": rwaCreditFund,
  "commodity-claim": commodityClaim,
  "ucits-trs-fund": ucitsTrsFund,
  "shared-reserve": sharedReserve,
  "protocol-position": protocolPosition,
} satisfies Record<MechanismArchetype, ArchetypeContent["metadata"]>;

export const MECHANISM_EXPLAINER_TITLES: Readonly<Record<MechanismArchetype, string>> = {
  "fiat-cash": fiatCash.title,
  "tbill": tbill.title,
  "cdp": cdp.title,
  "synthetic-delta-neutral": syntheticDeltaNeutral.title,
  "algorithmic": algorithmic.title,
  "rwa-credit-fund": rwaCreditFund.title,
  "commodity-claim": commodityClaim.title,
  "ucits-trs-fund": ucitsTrsFund.title,
  "shared-reserve": sharedReserve.title,
  "protocol-position": protocolPosition.title,
};
