import type { ProtocolFamily, ProtocolVariant, StablecoinMeta } from "../types";

const PROTOCOL_FAMILY_LABELS: Record<ProtocolFamily, string> = {
  liquity: "Liquity",
};

const PROTOCOL_VARIANT_LABELS: Record<ProtocolVariant, string> = {
  v1: "Liquity v1",
  v2: "Liquity v2",
  style: "Liquity-style",
};

export function getProtocolFamilyLabel(meta: Pick<StablecoinMeta, "protocolFamily" | "protocolVariant">): string | null {
  if (!meta.protocolFamily) return null;
  if (meta.protocolFamily === "liquity" && meta.protocolVariant) {
    return PROTOCOL_VARIANT_LABELS[meta.protocolVariant];
  }
  return PROTOCOL_FAMILY_LABELS[meta.protocolFamily];
}

export function getProtocolFamilySummary(meta: Pick<StablecoinMeta, "protocolFamily" | "protocolVariant">): string | null {
  if (meta.protocolFamily !== "liquity") return null;
  switch (meta.protocolVariant) {
    case "v1":
      return "Shares the classic Liquity design: 110% liquidation threshold, Stability Pool liquidations, and no ongoing borrower interest.";
    case "v2":
      return "Uses the newer Liquity / BOLD pattern with user-set borrower rates, branch-style collateral markets, and Stability Pools.";
    case "style":
      return "Follows a Liquity-style CDP and redemption design, but Pharos does not classify it as a strict v1 or v2 fork.";
    default:
      return "Part of the Liquity-family CDP design lineage.";
  }
}
