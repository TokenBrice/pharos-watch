export function leadFamily(lead: string | undefined): string | undefined {
  if (!lead) return undefined;
  if (lead.startsWith("psi-") || lead === "psi") return "psi";
  if (lead.includes("depeg")) return "depeg";
  if (lead.startsWith("dews")) return "dews";
  if (
    lead === "ftq"
    || lead.startsWith("mint-burn")
    || lead.startsWith("gauge-")
    || lead.startsWith("supply-")
    || lead === "chain-migration"
  ) return "flow";
  if (
    lead === "grade-transition"
    || lead === "yield-anomaly"
    || lead === "liquidity-shift"
    || lead === "blacklist-contrast"
    || lead === "reserve-event"
  ) return "risk";
  if (
    lead === "macro-observation"
    || lead === "market-structure"
    || lead === "issuer-concentration"
    || lead === "regime-divergence"
  ) return "macro";
  return "other";
}
