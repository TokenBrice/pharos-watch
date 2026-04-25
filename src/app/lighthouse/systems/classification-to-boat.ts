import type { GovernanceType, BackingType } from "@shared/types";

export type BoatStyle = "galleon" | "brigantine" | "schooner" | "junk";

interface Input {
  governance: GovernanceType | undefined;
  backing: BackingType | undefined;
}

export function boatStyleFor({ governance, backing }: Input): BoatStyle {
  if (backing === "algorithmic") return "junk";
  switch (governance) {
    case "centralized": return "galleon";
    case "centralized-dependent": return "brigantine";
    case "decentralized": return "schooner";
    default: return "schooner";
  }
}
