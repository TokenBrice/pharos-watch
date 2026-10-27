import registryJson from "../../data/safety-score-v9/lender-collateral-classes-v1.json";
import {
  LenderCollateralClassesRegistrySchema,
  type LenderCollateralClassReview,
  type LenderCollateralClassesRegistry,
} from "../../types/safety-score-v9-lender-book";
import { deepFreeze } from "../../types/safety-score-v9-immutable";
import { reviewedRegistryEnvelopeDigest } from "./reviewed-registry";

type ReviewedCollateralClasses = {
  readonly registry: Readonly<LenderCollateralClassesRegistry>;
  readonly digest: string;
  readonly get: (tokenKey: string) => Readonly<LenderCollateralClassReview> | undefined;
};

let admitted: ReviewedCollateralClasses | undefined;

/** Admit the authored registry once; lookups never normalize or alias token identities. */
export function getLenderCollateralClassesRegistry(): ReviewedCollateralClasses {
  if (admitted) return admitted;
  const registry = deepFreeze(LenderCollateralClassesRegistrySchema.parse(registryJson));
  const byToken: Record<string, Readonly<LenderCollateralClassReview>> = Object.create(null) as Record<string, Readonly<LenderCollateralClassReview>>;
  for (const row of registry.reviews) byToken[`${row.chain}:${row.address}`] = row;
  admitted = Object.freeze({
    registry,
    digest: reviewedRegistryEnvelopeDigest("safety-score-v9.lender-collateral-classes.v1", "payload", registry),
    get: (tokenKey: string) => byToken[tokenKey],
  });
  return admitted;
}
