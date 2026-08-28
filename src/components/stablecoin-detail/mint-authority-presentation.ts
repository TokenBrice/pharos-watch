import type { MintAuthorityPostureTone } from "@/lib/stablecoin-detail-mint-authority-view-model";

export const MINT_AUTHORITY_POSTURE_DOT_CLASS: Record<MintAuthorityPostureTone, string> = {
  minimized: "bg-[var(--severity-healthy)]",
  neutral: "bg-[var(--text-tertiary)]",
  elevated: "bg-[var(--severity-mild)]",
};
