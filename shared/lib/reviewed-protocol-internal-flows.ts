/**
 * Individually reviewed mint/burn events that moved tokens inside an issuer's
 * own balance sheet rather than between holders and the issuer.
 *
 * The mint/burn pipeline tags matching rows `flow_type = 'protocol_internal'`,
 * which keeps them out of every counted aggregate (hourly buckets, net flow,
 * pressure, Bank Run Gauge) while the event stays visible in the uncounted event
 * ledger. Frontend supply surfaces read the same entries so a reviewed internal
 * move is not headlined as holder-driven supply change.
 *
 * Entries are keyed by exact event id (chain, tx hash, log index) and pinned to
 * the reviewed token amount. There is deliberately no address-level rule: the
 * reviewed USD.AI burn used the same `withdraw()` path an ordinary redemption
 * uses, so only per-event evidence can separate the two.
 */
interface ReviewedProtocolInternalFlow {
  eventId: string;
  stablecoinId: string;
  chainId: string;
  direction: "mint" | "burn";
  /** Reviewed token-native amount. */
  amount: number;
  /** Block timestamp of the event, Unix seconds. */
  occurredAtSec: number;
  reviewedAt: string;
  rationale: string;
  sources: readonly string[];
}

const REVIEWED_PROTOCOL_INTERNAL_FLOWS: readonly ReviewedProtocolInternalFlow[] = [
  {
    eventId: "arbitrum-0x46dc4ae95582c3d92d2ada242fc7445b6f4408284d271f69e2f98668993559d7-4",
    stablecoinId: "usdai-usd-ai",
    chainId: "arbitrum",
    direction: "burn",
    amount: 128_895_244.1,
    // Arbitrum block 508,237,173 (2026-09-23T20:48:00Z).
    occurredAtSec: 1_790_196_480,
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

export const REVIEWED_PROTOCOL_INTERNAL_FLOW_BY_EVENT_ID: Readonly<Record<string, ReviewedProtocolInternalFlow>> =
  Object.fromEntries(REVIEWED_PROTOCOL_INTERNAL_FLOWS.map((entry) => [entry.eventId, entry]));

/** True when the coin has a reviewed protocol-internal mint or burn at or after `sinceSec`. */
export function hasReviewedProtocolInternalFlowSince(stablecoinId: string, sinceSec: number): boolean {
  return REVIEWED_PROTOCOL_INTERNAL_FLOWS.some(
    (entry) => entry.stablecoinId === stablecoinId && entry.occurredAtSec >= sinceSec,
  );
}
