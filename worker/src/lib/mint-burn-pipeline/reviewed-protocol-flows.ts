import { REVIEWED_PROTOCOL_INTERNAL_FLOW_BY_EVENT_ID } from "@shared/lib/reviewed-protocol-internal-flows";
import type { MintBurnRow } from "./types";

const AMOUNT_TOLERANCE = 1e-6;

/**
 * Tags reviewed protocol-internal rows in place; returns how many were tagged.
 * The registry lives in `shared/lib/reviewed-protocol-internal-flows.ts`. A row
 * whose amount no longer matches its review keeps its normal classification
 * (fail closed).
 */
export function applyReviewedProtocolInternalFlows(rows: MintBurnRow[]): number {
  let tagged = 0;
  for (const row of rows) {
    const review = REVIEWED_PROTOCOL_INTERNAL_FLOW_BY_EVENT_ID[row.id];
    if (!review) continue;
    if (
      row.stablecoin_id !== review.stablecoinId ||
      row.chain_id !== review.chainId ||
      row.direction !== review.direction ||
      Math.abs(row.amount - review.amount) > AMOUNT_TOLERANCE * review.amount
    ) {
      continue;
    }
    row.flow_type = "protocol_internal";
    tagged++;
  }
  return tagged;
}
