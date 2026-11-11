import type { StablecoinLink } from "@shared/types/stablecoin-meta-primitives";
import type { FaqItem } from "@/lib/faq";

interface StablecoinHistoricalContext {
  faq: FaqItem;
  profileHeading: string;
  references: StablecoinLink[];
}

/** Reviewed historical context, separate from the dossier's live peg verdict. */
export const STABLECOIN_HISTORICAL_CONTEXT: Readonly<Partial<Record<string, StablecoinHistoricalContext>>> = {
  "usdc-circle": {
    faq: {
      question: "Has USDC depegged?",
      answer:
        "Yes. USDC traded below its $1 target in March 2023 after Silicon Valley Bank failed and Circle disclosed reserve exposure to the bank. It recovered after authorities announced protection for SVB depositors. This historical recovery is not a guarantee of future peg stability.",
    },
    profileHeading: "USDC depeg history",
    references: [
      { label: "March 2023 USDC depeg timeline", url: "/depeg/usdc-2023-03-11/" },
      { label: "Why USDC depegged during the SVB crisis", url: "/learn/case-studies/usdc-svb-2023/" },
    ],
  },
};
