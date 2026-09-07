import {
  createEmptyPrimaryConsensusQuoteMaps,
  type PrimaryConsensusQuoteMaps,
} from "../enrich-prices-primary-provider-collection";
import type { PriceValidationStats } from "../enrich-prices-shared";

export function createEmptyQuoteMaps(): PrimaryConsensusQuoteMaps {
  return createEmptyPrimaryConsensusQuoteMaps();
}

export function createStats(): PriceValidationStats {
  return {
    attempted: 0,
    high: 0,
    singleSource: 0,
    cgOnly: 0,
    low: 0,
  };
}
