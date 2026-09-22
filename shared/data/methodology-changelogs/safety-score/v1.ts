import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V1: readonly MethodologyChangelogEntry[] = [
    {
      version: "1.0",
      title: "Initial implementation",
      date: "2026-02-25",
      effectiveAt: 1771977600,
      summary:
        "First release with six weighted dimensions: Peg Stability, Liquidity, Safety, Resilience, Decentralization, and Dependency Risk.",
      impact: [
        "Six dimensions with grade thresholds from A+ (>=97) to F (>=0)",
        "Minimum 3 rated dimensions required for overall grade",
      ],
      detail: [
        { kind: "paragraph", text: "Six weighted dimensions:" },
        {
          kind: "table",
          ariaLabel: "Safety Score v1 weighted dimensions",
          tableId: "scoring-v1-weighted-dimensions",
          testId: "scoring-v1-weighted-dimensions-table",
          columns: [
            { id: "dimension", label: "Dimension", rowHeader: true },
            { id: "weight", label: "Weight" },
            { id: "approach", label: "Approach" },
          ],
          rows: [
            {
              id: "Peg Stability",
              cells: { dimension: "Peg Stability", weight: "25%", approach: "pegScore passthrough, capped at 65 during active depeg, +3 bonus if last depeg > 12 months ago" },
            },
            {
              id: "Liquidity",
              cells: { dimension: "Liquidity", weight: "25%", approach: "liquidityScore from DEX data, HHI penalty (−5 if >0.5, −10 if >0.8)" },
            },
            {
              id: "Safety",
              cells: { dimension: "Safety", weight: "20%", approach: "Bluechip rating passthrough (A+=100 … F=25), NR if no rating" },
            },
            {
              id: "Resilience",
              cells: { dimension: "Resilience", weight: "15%", approach: "2-factor: chain distribution 60% + freeze rate 40%" },
            },
            {
              id: "Decentralization",
              cells: { dimension: "Decentralization", weight: "10%", approach: "3-tier: decentralized=95, centralized-dependent=70, centralized=50" },
            },
            {
              id: "Dependency Risk",
              cells: { dimension: "Dependency Risk", weight: "5%", approach: "CeFi-Dependent only, unweighted avg of upstream scores" },
            },
          ],
        },
        { kind: "paragraph", text: "Grade thresholds: A+≥97, A≥93, A−≥90, B+≥85, B≥80, B−≥75, C+≥70, C≥65, C−≥60, D≥50. Minimum 3 rated dimensions required." },
        {
          kind: "section",
          heading: "Day-one patches",
          blocks: [
            {
              kind: "list",
              items: [
                "Dependencies switched from unweighted to weighted averages",
                "Dependency renormalization fix: partial backing properly penalized via self-backed blending",
                "Peg +3 bonus restricted to coins with actual depeg history",
                "NAV tokens included in grading",
                "Rebalanced: dependency 5%→15%, resilience 15%→10%, decentralization 10%→5%",
              ],
            },
          ],
        },
      ],
      commits: ["66ec5c4", "9c7ccc9", "c11e37c"],
      reconstructed: true,
    },
];
