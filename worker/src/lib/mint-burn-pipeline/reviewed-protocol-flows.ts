import type { MintBurnRow } from "./types";

/**
 * Individually reviewed mint/burn events that moved tokens inside an issuer's
 * own balance sheet rather than between holders and the issuer. Matching rows
 * are tagged `flow_type = 'protocol_internal'`, which keeps them out of every
 * counted aggregate (hourly buckets, net flow, pressure, Bank Run Gauge) while
 * the event itself stays visible in the uncounted event ledger.
 *
 * Entries are keyed by exact event id (chain, tx hash, log index) and pinned to
 * the reviewed token amount. There is deliberately no address-level rule: the
 * reviewed USD.AI burn used the same `withdraw()` path an ordinary redemption
 * uses, so only per-event evidence can separate the two. A row whose amount no
 * longer matches its review keeps its normal classification (fail closed).
 */
export interface ReviewedProtocolInternalFlow {
  eventId: string;
  stablecoinId: string;
  chainId: string;
  direction: "mint" | "burn";
  /** Reviewed token-native amount. */
  amount: number;
  reviewedAt: string;
  rationale: string;
  sources: readonly string[];
}

export const REVIEWED_PROTOCOL_INTERNAL_FLOWS: readonly ReviewedProtocolInternalFlow[] = [
  {
    eventId: "arbitrum-0x46dc4ae95582c3d92d2ada242fc7445b6f4408284d271f69e2f98668993559d7-4",
    stablecoinId: "usdai-usd-ai",
    chainId: "arbitrum",
    direction: "burn",
    amount: 128_895_244.1,
    reviewedAt: "2026-09-27",
    rationale:
      "sUSDai loan deployment. The sUSDai vault funded USD.AI's EscrowTimelock escrow-admin Safe with exactly 128,895,244.1 USDai " +
      "(6,444,762.2 + 122,450,481.9) the same evening; the Safe then burned it through the hub and received 128,895,243.0 PYUSD at a " +
      "recipient address. USD.AI's dashboard loan-reserve series rose by exactly 128,895,244.1 between 20:29:59 and 20:59:59 UTC while " +
      "cash fell by 128,895,237.18 and protocol TVL stayed near $609.05M.",
    sources: [
      "https://arbiscan.io/tx/0x46dc4ae95582c3d92d2ada242fc7445b6f4408284d271f69e2f98668993559d7",
      "https://arbiscan.io/tx/0xe0426f3a2a621f5d12295541c97279f9858982d4764b789462a5439ccc05e0fb",
      "https://arbiscan.io/tx/0x8e2c781ab01336719afb8948332961018d87fec714e1797fcb9768883ca72dcd",
      "https://arbitrum.blockscout.com/api/v2/smart-contracts/0xDDC88CD5d825747E5517eAb8fCa99dfB4f283887",
      "https://app.usd.ai/dashboard",
    ],
  },
];

const AMOUNT_TOLERANCE = 1e-6;

const REVIEWED_BY_EVENT_ID: Readonly<Record<string, ReviewedProtocolInternalFlow>> = Object.fromEntries(
  REVIEWED_PROTOCOL_INTERNAL_FLOWS.map((entry) => [entry.eventId, entry]),
);

/** Tags reviewed protocol-internal rows in place; returns how many were tagged. */
export function applyReviewedProtocolInternalFlows(rows: MintBurnRow[]): number {
  let tagged = 0;
  for (const row of rows) {
    const review = REVIEWED_BY_EVENT_ID[row.id];
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
