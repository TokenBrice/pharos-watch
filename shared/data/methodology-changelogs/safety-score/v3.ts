import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V3: readonly MethodologyChangelogEntry[] = [
    {
      version: "3.3",
      title: "Reserve-derived collateral quality",
      date: "2026-02-27",
      effectiveAt: 1772150401,
      summary:
        "For coins with curated reserves arrays, collateral quality is now a weighted average of reserve risk tiers instead of an enum fallback.",
      impact: [
        "Reserve risk tiers: very-low=100, low=75, medium=50, high=25, very-high=5",
        "Decentralization weight raised 10->15%",
      ],
      detail: [
        {
          kind: "paragraph",
          text: "For coins with curated reserve composition data, collateral quality is computed as a weighted average of per-slice risk scores instead of using the enum fallback:",
        },
        {
          kind: "table",
          ariaLabel: "Safety Score v3.3 reserve risk tiers",
          tableId: "scoring-v3-reserve-risk-tiers",
          testId: "scoring-v3-reserve-risk-tiers-table",
          columns: [{ id: "tier", label: "Reserve risk tier", rowHeader: true }, { id: "score", label: "Score" }],
          rows: [
            { id: "very-low", cells: { tier: "very-low", score: "100" } },
            { id: "low", cells: { tier: "low", score: "75" } },
            { id: "medium", cells: { tier: "medium", score: "50" } },
            { id: "high", cells: { tier: "high", score: "25" } },
            { id: "very-high", cells: { tier: "very-high", score: "5" } },
          ],
        },
      ],
      commits: ["25602d1", "1cd1bb9"],
      reconstructed: true,
    },
    {
      version: "3.2",
      title: "Dependency type ceilings",
      date: "2026-02-27",
      effectiveAt: 1772150400,
      summary:
        "New DependencyType field (wrapper/mechanism/collateral) with ceilings preventing wrappers from scoring above upstream.",
      impact: ["Wrapper ceiling = upstream_score - 3, mechanism ceiling = upstream_score, collateral = no ceiling"],
      detail: [
        {
          kind: "paragraph",
          text: [
            "New dependency types: ",
            { code: "wrapper" },
            ", ",
            { code: "mechanism" },
            ", ",
            { code: "collateral" },
            " (default). After blended score is computed, ceilings apply:",
          ],
        },
        {
          kind: "list",
          items: [
            [{ emphasis: "wrapper" }, " → ceiling = upstream − 3"],
            [{ emphasis: "mechanism" }, " → ceiling = upstream"],
            [{ emphasis: "collateral" }, " → no ceiling"],
          ],
        },
        { kind: "paragraph", text: "Prevents thin wrappers (e.g. a USDC wrapper) from scoring higher than their upstream." },
      ],
      commits: ["fa1d992"],
      reconstructed: true,
    },
    {
      version: "3.0",
      title: "Resilience 4-factor model",
      date: "2026-02-26",
      effectiveAt: 1772064001,
      summary:
        "Complete Resilience redesign from 2 factors to 4 equal sub-factors: chain risk, collateral quality, custody model, blacklist capability.",
      impact: [
        "Chain risk, collateral quality, custody model, and blacklist each weighted 25%",
        "New types: ChainRisk, CollateralQuality, CustodyModel with tier-based scoring",
      ],
      detail: [
        { kind: "paragraph", text: "Complete redesign of Resilience from 2 factors (chain distribution + freeze rate) to 4 equal sub-factors (25% each):" },
        {
          kind: "table",
          ariaLabel: "Safety Score v3 resilience sub-factors",
          tableId: "scoring-v3-resilience-subfactors",
          testId: "scoring-v3-resilience-subfactors-table",
          columns: [{ id: "factor", label: "Sub-factor", rowHeader: true }, { id: "tiers", label: "Tiers & scores" }],
          rows: [
            {
              id: "Chain Risk",
              cells: { factor: "Chain Risk", tiers: "ethereum=100, stage1-l2=66, established-alt-l1=20, unproven=0" },
            },
            {
              id: "Collateral Quality",
              cells: { factor: "Collateral Quality", tiers: "native=100, eth-lst=66, alt-lst-bridged-or-mixed=20, rwa=50, exotic=0" },
            },
            {
              id: "Custody Model",
              cells: { factor: "Custody Model", tiers: "onchain=100, institutional=50, cex=0" },
            },
            {
              id: "Blacklist Capability",
              cells: { factor: "Blacklist Capability", tiers: "not-blacklistable=100, possible=50, blacklistable=0" },
            },
          ],
        },
        { kind: "weights", values: ["25%", "20%", "—", "20%", "10%", "25%"] },
      ],
      commits: ["ff9d589", "46fe511", "c45f007"],
      reconstructed: true,
    },
];
