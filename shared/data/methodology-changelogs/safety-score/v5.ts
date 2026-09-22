import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V5: readonly MethodologyChangelogEntry[] = [
    {
      version: "5.9",
      title: "Classification corrections: centralized-custody DeFi coins",
      date: "2026-03-20",
      effectiveAt: 1773964800,
      summary:
        "Three DeFi-classified coins with >50% centralized custody exposure reclassified to centralized-dependent based on live reserve data.",
      impact: [
        "meUSD, ALUSD, BtcUSD reclassified from decentralized to centralized-dependent",
        "ALUSD correction: 65% USDC+USDT direct exposure (reverts erroneous v4.1 reclassification)",
        "meUSD and BtcUSD: live reserves confirm 100% custodial BTC variants (WBTC, BTCB, cbBTC, SolvBTC)",
      ],
      detail: [
        { kind: "paragraph", text: "Three DeFi-classified coins were corrected after live reserve review showed majority centralized custody exposure." },
        {
          kind: "list",
          items: [
            [
              { emphasis: "meUSD" },
              ", ",
              { emphasis: "ALUSD" },
              ", and ",
              { emphasis: "BtcUSD" },
              " were reclassified from decentralized to centralized-dependent.",
            ],
            "ALUSD's earlier v4.1 correction was explicitly reversed after reserve review showed majority direct USDC/USDT exposure.",
            "meUSD and BtcUSD were corrected after live reserves confirmed custodial BTC-variant backing.",
          ],
        },
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.8",
      title: "Live reserve passthrough for collateral quality",
      date: "2026-03-14",
      effectiveAt: 1773446400,
      summary:
        "Collateral quality scoring now consumes live reserve snapshots when available, using hourly data from reserve_composition instead of curated metadata.",
      impact: [
        "Coins with liveReservesConfig use fresh (<48h) live snapshots for collateral quality instead of curated metadata",
        "Delta alert fires when live-derived score diverges from curated by >15 points",
        "Dependency inference remains on curated data (live slices lack coinId links)",
      ],
      detail: [
        {
          kind: "paragraph",
          text: [
            "Collateral quality scoring now consumes ",
            { emphasis: "live reserve snapshots" },
            " when available, using hourly data from ",
            { code: "reserve_composition" },
            " instead of curated metadata.",
          ],
        },
        {
          kind: "list",
          items: [
            ["Coins with ", { code: "liveReservesConfig" }, " use fresh (<48h) live snapshots for collateral quality instead of curated metadata."],
            "Delta alert fires when live-derived score diverges from curated by >15 points.",
            "Dependency inference remains on curated data (live slices lack coinId links).",
          ],
        },
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.7",
      title: "Canonical ETH wrapper reserve alignment",
      date: "2026-03-13",
      effectiveAt: 1773360000,
      summary:
        "Reserve-derived collateral quality now treats direct ETH and canonical wrapped ETH as the same very-low-risk asset class.",
      impact: [
        "Canonical WETH no longer falls into the generic wrapped-asset bucket in the reserve-asset risk map",
        "Curated reserve metadata and live reserve-adapter overrides aligned for coins exposing ETH/WETH slices",
      ],
      detail: [
        {
          kind: "paragraph",
          text: [
            "Direct ",
            { emphasis: "ETH" },
            " and canonical",
            { emphasis: " WETH" },
            " reserve slices now share the same",
            { emphasis: " very-low" },
            " risk tier.",
          ],
        },
        {
          kind: "list",
          items: [
            "Updated the shared direct-asset reserve map used by live reserve adapters so `WETH` no longer falls into the generic wrapped-asset bucket.",
            "Aligned curated reserve metadata and live config overrides for coins that expose plain `WETH` or `ETH` slices.",
            "Left mixed strategy buckets unchanged. Delta-neutral ETH exposures, bridged ETH buckets, and mixed BTC/ETH slices still use their existing manually-modeled risk tiers.",
          ],
        },
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.6",
      title: "Exit-liquidity integration",
      date: "2026-03-12",
      effectiveAt: 1773273600,
      summary:
        "Safety Score liquidity now evaluates modeled exit quality via redemption backstops, not just raw DEX depth.",
      impact: [
        "Liquidity dimension uses effectiveExitScore, preserving DEX liquidity as floor while redemption quality can improve it",
        "Route-family caps prevent queue-based and offchain issuer systems from appearing unrealistically liquid",
      ],
      detail: [
        {
          kind: "paragraph",
          text: [
            "The Safety Score liquidity dimension now evaluates",
            { emphasis: " exit liquidity" },
            ", not just raw DEX depth.",
          ],
        },
        {
          kind: "list",
          items: [
            [
              "Added a new ",
              { emphasis: "redemption backstop dataset" },
              "for redeemable assets, covering onchain collateral redemptions, stable basket redemptions, queue-based liquid-buffer systems, and issuer redemption rails.",
            ],
            [
              "The report-card Liquidity dimension now uses an",
              { emphasis: " effective exit score" },
              ": DEX liquidity remains the floor, while redemption quality can improve the dimension without redefining the standalone DEX liquidity score.",
            ],
            "Added route-family caps so queue-based and offchain issuer systems cannot look unrealistically liquid even when redemption exists.",
          ],
        },
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.5",
      title: "Peg score fairness for young coins",
      date: "2026-03-01",
      effectiveAt: 1772323200,
      summary: "Three peg-scoring fixes prevent young coins with repeated brief depegs from being over-scored.",
      impact: [
        "Tracking window capped to coin age via coinTrackingStart()",
        "Severity magnitude floor ensures each depeg contributes a minimum penalty",
        "Steeper active-depeg penalty: max(5, absBps/50), capped at 50",
      ],
      detail: [
        { kind: "paragraph", text: "Three fixes to the peg score formula that prevent young coins with chronic depegs from scoring artificially high:" },
        {
          kind: "list",
          items: [
            [
              { emphasis: "Tracking window capped at coin age" },
              " — uses the coin's earliest supply snapshot instead of always defaulting to a 4-year window. A 30-day-old coin is now scored over 30 days, not 1,461.",
            ],
            [
              { emphasis: "Severity magnitude floor" },
              " — every depeg event carries a minimum penalty of (peakBps\u00a0/\u00a02000)\u00a0×\u00a0recencyWeight, regardless of duration. Hundreds of brief high-magnitude depegs now accumulate real cost.",
            ],
            [{ emphasis: "Active depeg penalty steepened" }, " — floor raised from 2 to 5, divisor changed from 200 to 50. A 500\u00a0bps ongoing depeg now costs 10 points (was 2.5)."],
          ],
        },
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.4",
      title: "No-liquidity penalty",
      date: "2026-02-28",
      effectiveAt: 1772236804,
      summary:
        "When Liquidity is NR (no DEX data), overall score receives a 10% penalty instead of redistributing weight.",
      impact: ["NR liquidity now applies final *= 0.9 after peg multiplier instead of inflating other dimensions"],
      detail: [
        {
          kind: "paragraph",
          text: [
            "When the Liquidity dimension is NR (no DEX data), the overall score now receives a ",
            { emphasis: "10% penalty" },
            " instead of silently redistributing the weight to other dimensions.",
          ],
        },
        { kind: "formula", text: "final = score × 0.9" },
        { kind: "paragraph", text: "As DEX pipeline coverage matures, absence of liquidity data is increasingly suspect and should not inflate grades." },
      ],
      commits: ["14131fa"],
      reconstructed: true,
    },
    {
      version: "5.3",
      title: "Remove chain infra from Resilience",
      date: "2026-02-28",
      effectiveAt: 1772236803,
      summary:
        "Chain infra double-counting fixed: removed from Resilience sub-factors, now exclusively in Decentralization.",
      impact: ["Resilience becomes a 3-factor model (collateral quality, custody model, blacklist capability)"],
      detail: [
        {
          kind: "paragraph",
          text: [
            "Chain infrastructure was scored in ",
            { emphasis: "both" },
            " Resilience (as a 25% sub-factor) and Decentralization (as a penalty) — double-counting chain risk.",
          ],
        },
        {
          kind: "list",
          items: [
            ["Chain infra now scored ", { emphasis: "exclusively in Decentralization" }],
            "Resilience becomes a 3-factor model (each &frac13;): Collateral Quality, Custody Model, Blacklist Capability",
          ],
        },
      ],
      commits: ["8c060b3"],
      reconstructed: true,
    },
    {
      version: "5.2",
      title: "Immutable-code governance tier",
      date: "2026-02-28",
      effectiveAt: 1772236802,
      summary:
        "Added immutable-code as highest GovernanceQuality tier (score 100) for protocols with no admin keys or upgrade path.",
      impact: ["LUSD, BOLD now score 100 in governance quality; exempt from chain infra penalty"],
      detail: [
        {
          kind: "paragraph",
          text: [
            "New highest GovernanceQuality tier: ",
            { emphasis: "immutable-code → 100" },
            ". For protocols with no admin keys, no upgrade path, no DAO attack surface (e.g. LUSD, BOLD). Exempt from chain infrastructure penalty.",
          ],
        },
        {
          kind: "section",
          heading: "Full GovernanceQuality tiers",
          blocks: [
            {
              kind: "table",
              ariaLabel: "Safety Score v5 GovernanceQuality tiers",
              tableId: "scoring-v5-governance-quality-tiers",
              testId: "scoring-v5-governance-quality-tiers-table",
              columns: [{ id: "tier", label: "Tier", rowHeader: true }, { id: "score", label: "Score" }],
              rows: [
                { id: "immutable-code", cells: { tier: "immutable-code", score: "100" } },
                { id: "dao-governance", cells: { tier: "dao-governance", score: "85" } },
                { id: "multisig", cells: { tier: "multisig", score: "55" } },
                { id: "regulated-entity", cells: { tier: "regulated-entity", score: "40" } },
                { id: "single-entity", cells: { tier: "single-entity", score: "20" } },
                { id: "wrapper", cells: { tier: "wrapper", score: "10" } },
              ],
            },
          ],
        },
      ],
      commits: ["c6c0b77"],
      reconstructed: true,
    },
    {
      version: "5.1",
      title: "Regulated-entity tier + blacklist softening",
      date: "2026-02-28",
      effectiveAt: 1772236801,
      summary:
        "Blacklist scores softened (blacklistable 0->33) and regulated-entity governance tier added for licensed issuers.",
      impact: [
        "Blacklist scoring: blacklistable 0->33, possible 50->66, not-blacklistable stays 100",
        "Regulated-entity tier (score 40) auto-promoted from single-entity when regulator+license+independent audit",
        "Grade thresholds lowered another 5 points (A+ >= 87)",
      ],
      detail: [
        {
          kind: "list",
          items: [
            [{ emphasis: "Blacklist scoring softened" }, ": blacklistable 0→33, possible 50→66, not-blacklistable 100 (unchanged). Non-zero floor for blacklistable tokens."],
            [
              { emphasis: "regulated-entity tier" },
              " added (score 40). Auto-promoted from single-entity when: jurisdiction regulator + license set, and proof of reserves via independent audit. Exempt from chain infra penalty.",
            ],
            [{ emphasis: "Grade thresholds lowered 5 points" }, " (C-range overcrowding after blacklist/decentralization changes)."],
          ],
        },
      ],
      commits: ["38cbe20", "86b8ce1", "01ed304", "fc6cd6c"],
      reconstructed: true,
    },
    {
      version: "5.0",
      title: "GovernanceQuality + universal dependency scoring",
      date: "2026-02-28",
      effectiveAt: 1772236800,
      summary:
        "Decentralization moved from 3-tier to 6-tier GovernanceQuality. Dependency scoring became universal (not CeFi-only).",
      impact: [
        "GovernanceQuality tiers: dao-governance=85, multisig=55, single-entity=20, wrapper=10",
        "All coins with upstream dependencies now scored, not just centralized-dependent",
        "Chain infra scored as ChainTier x DeploymentModel multiplier in Resilience",
      ],
      detail: [
        {
          kind: "section",
          heading: "Decentralization: 3-tier → 6-tier GovernanceQuality",
          blocks: [
            {
              kind: "paragraph",
              text: "The blunt 3-level governance type (decentralized / centralized-dependent / centralized) replaced by a 6-tier GovernanceQuality scale, inferred from governance type when not explicitly set.",
            },
          ],
        },
        {
          kind: "section",
          heading: "Dependency Risk: universal, not CeFi-only",
          blocks: [
            {
              kind: "paragraph",
              text: "All coins with upstream dependencies are now scored — not just centralized-dependent ones. Self-backed scores vary by governance type: decentralized 90, centralized-dependent 75, centralized 95. Dependencies auto-derived from reserve composition data.",
            },
          ],
        },
        {
          kind: "section",
          heading: "Chain infrastructure restructured",
          blocks: [{ kind: "paragraph", text: "New two-axis model: ChainTier × DeploymentModel multiplier. Threshold-based penalty applied to the Decentralization dimension." }],
        },
        { kind: "weights", values: ["multiplier", "30%", "—", "20%", "15%", "25%"] },
      ],
      commits: ["e915623", "e516bbf", "d4dd044", "0b603d2", "83a540a"],
      reconstructed: true,
    },
];
