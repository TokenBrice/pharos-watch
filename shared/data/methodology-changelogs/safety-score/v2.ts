import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V2: readonly MethodologyChangelogEntry[] = [
    {
      version: "2.0",
      title: "Remove Safety dimension",
      date: "2026-02-26",
      effectiveAt: 1772064000,
      summary:
        "Safety dimension removed due to sparse Bluechip rating coverage (~20/142 coins). Bluechip display kept for informational use.",
      impact: ["Safety dimension dropped; weight redistributed to remaining 5 dimensions"],
      detail: [
        {
          kind: "paragraph",
          text: "Only ~20 of 142 coins had Bluechip ratings. Sparse coverage caused inconsistent weight redistribution. Safety dimension removed entirely; Bluechip display kept for informational use.",
        },
        { kind: "weights", values: ["25%", "25%", "removed", "15%", "10%", "25%"] },
        {
          kind: "section",
          heading: "Other changes in the v2 era",
          blocks: [
            {
              kind: "list",
              items: [
                "Self-backed CeFi-Dependent score lowered 95→75 (systemic coupling risk)",
                "Active-depeg cap and +3 bonus removed from peg stability (pegScore already encodes severity)",
                "HHI concentration penalty removed from liquidity",
                "Decentralization widened: decentralized 95→100, centralized-dependent 70→50, centralized 50→0",
                "“Possible” blacklist tier added (0/50/100 scale)",
                "Chain-risk penalty on decentralization: stage1-l2 −15, established-alt-l1 −50, unproven −65",
              ],
            },
          ],
        },
      ],
      commits: ["a272ca8"],
      reconstructed: true,
    },
];
