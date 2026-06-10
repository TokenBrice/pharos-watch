import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const REDEMPTION_BACKSTOP_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.07",
    title: "Conservative confidence defaults and final-state depeg gating",
    date: "2026-06-10",
    effectiveAt: 1781049600,
    summary:
      "Conservative confidence defaults in the effective-exit blend, live-proxy unknown-route-status rolls up low confidence, and the severe-depeg exemption is re-evaluated against the final resolved capacity state.",
    impact: [
      "A v4 effective-exit blend invoked without model confidence now applies the low (0.35) confidence factor instead of full redemption weight",
      "Live-proxy capacity with unknown route status always rolls up low model confidence; only live-direct telemetry or source-reviewed documented bounds keep unknown route status above low",
      "The strong live-direct severe-depeg exemption is asserted against the final resolved capacity state, so live routes downgraded to fallback or heuristic capacity are impaired during severe active depegs",
      "Output-asset impairment rows now flag over-leveraged dependency compositions whose reserve-derived weights sum above 100% of supply while keeping the impaired share clamped at 100%",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.06",
    title: "fxSAVE uses live ERC-4626 capacity",
    date: "2026-05-27",
    effectiveAt: 1779840000,
    summary:
      "fxSAVE redemption capacity now uses fresh ERC-4626 reserve-sync telemetry from the vault's idle fxSP balance instead of a heuristic strategy-buffer ratio.",
    impact: [
      "`fxsave-f-x-protocol` moves from a static 20% heuristic capacity model to `reserve-sync-metadata`",
      "Fresh clean snapshots resolve as live-direct current capacity and can produce medium model confidence despite the reviewed variable-fee route",
      "The route fails closed as unrated when live ERC-4626 telemetry is stale, missing, or degraded, avoiding heuristic Safety Score uplift",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.05",
    title: "ZCHF bridge capacity follows CHFAU",
    date: "2026-05-25",
    effectiveAt: 1779732000,
    summary:
      "Frankencoin ZCHF redemption capacity now uses the active CHFAU StablecoinBridge instead of the expired VCHF bridge, restoring live bridge-buffer telemetry for permissionless ZCHF exits.",
    impact: [
      "`zchf-frankencoin` now probes the CHFAU bridge at `0x3e445ff4dddf0ff8ae7458c9746ed80bd664f6c1` and CHFAU token `0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78`",
      "The old VCHF bridge remains documented historically but no longer supplies current capacity because its inventory is zero and its horizon expired on April 15, 2026",
      "Until Frankencoin's price API publishes CHFAU directly, bridge telemetry values CHFAU at the existing VCHF CHF-price proxy and keeps a conservative 0.85% fallback buffer",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.04",
    title: "Documented-bound confidence and live wrapper capacity",
    date: "2026-05-17",
    effectiveAt: 1778976000,
    summary:
      "Documented-bound redemption capacity can retain medium model confidence when route status is unknown, ERC-4626 wrappers can use live idle-underlying balances as direct capacity, and source-reviewed RWA, fiat, and wrapper coverage expands.",
    impact: [
      "Resolved routes with `routeStatus: unknown` and `capacityConfidence: documented-bound` now keep medium model confidence when the rest of the evidence gates pass",
      "`routeStatus: unknown` remains a low-confidence signal for live-proxy, dynamic, heuristic, and unresolved capacity evidence",
      "This lets source-reviewed bounded routes avoid being downgraded solely because explicit route-status telemetry is unavailable, without treating proxy liquidity as current direct redemption evidence",
      "ERC-4626 single-asset wrappers can now score fresh idle underlying ERC-20 balances as direct redemption capacity; the Spark, Sky, Curve, Frax, and Cap wrapper configs use that live path instead of full-supply immediate capacity",
      "Source-reviewed coverage adds active Spiko, Anemoy, Securitize, Hamilton Lane, MXNe, Ripio wFIAT, and EUR0 routes while keeping pre-launch USDPT, USDB Bridge, USDF Flipcash, and FIUSD deferred until runtime eligibility is clearer",
      "Coverage rises to 304 configured redemption routes, with route-family totals now at 148 offchain-issuer, 60 stablecoin-redeem, 41 collateral-redeem, 36 queue-redeem, 10 psm-swap, and 9 basket-redeem",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.03",
    title: "RWA NAV route source review",
    date: "2026-05-14",
    effectiveAt: 1778760000,
    summary:
      "Source-reviewed coverage adds documented NAV, wrapper, and commodity redemption routes for the latest RWA expansion batch while leaving unsupported private-credit direct deals unmodeled.",
    impact: [
      "JAAA, ACRDX, STAC, HLSCOPE, SAFO, EURSAFO, GBPSAFO, UKTBL, SPKCC, EURSPKCC, mF-ONE, mGLOBAL, mHYPER, mMEV, and mAPOLLO now carry documented-bound offchain issuer redemption routes at NAV",
      "asUSDF now carries a queued wrapper exit back into USDF, XNK now carries a commodity issuer exchange route for physical gold, and USDF's Aster redemption config reflects the reviewed fee and settlement terms",
      "Tradable private-credit direct-deal tokens remain intentionally unmodeled until a public issuer redemption route can be verified",
      "Coverage rises to 297 configured redemption routes, with route-family totals now at 142 offchain-issuer, 60 stablecoin-redeem, 41 collateral-redeem, 36 queue-redeem, 10 psm-swap, and 8 basket-redeem",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.02",
    title: "Follow-up redemption coverage expansion",
    date: "2026-05-13",
    effectiveAt: 1778673600,
    summary:
      "Source-reviewed follow-up coverage adds documented Mento local-FX CDP routes, Enosys CDP redemptions, Blast USDB bridge exit, Metal Dollar basket redemption, MoveUSD issuer redemption, and Solomon USDv whitelisted reserve-buffer redemption.",
    impact: [
      "AUDm, BRLm, CADm, COPm, GHSm, KESm, PHPm, and ZARm now carry documented-bound Mento CDP collateral-redeem routes with explicit notes that current per-symbol CDP telemetry is not modeled yet",
      "CDP Enosys now carries a Liquity-style collateral-redeem route, while USDB and USDv add stablecoin-redeem coverage and XMD adds whitelisted basket-redeem coverage",
      "MoveUSD now carries a source-reviewed offchain issuer redemption route through CFX designated channels for verified customers",
      "Coverage rises to 280 configured redemption routes, with route-family totals now at 126 offchain-issuer, 60 stablecoin-redeem, 41 collateral-redeem, 35 queue-redeem, 10 psm-swap, and 8 basket-redeem",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.01",
    title: "Yearn yBOLD wrapper redemption coverage",
    date: "2026-05-12",
    effectiveAt: 1778608800,
    summary:
      "yBOLD now has a reviewed Yearn ERC-4626 wrapper redemption route into BOLD, keeping the wrapper exit separate from BOLD's downstream Liquity collateral-redemption route.",
    impact: [
      "`ybold-yearn` now carries a source-reviewed stablecoin-redeem route using documented-bound supply-full capacity semantics",
      "Coverage rises to 267 configured redemption routes, with route-family totals now at 125 offchain-issuer, 58 stablecoin-redeem, 32 collateral-redeem, 35 queue-redeem, 10 psm-swap, and 7 basket-redeem",
      "The route notes clarify that yBOLD exits into BOLD at the Yearn vault exchange rate, while final par exit quality still inherits BOLD's Liquity collateral-redemption path",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.0",
    title: "Current-capacity scoring and evidence-aware route quality",
    date: "2026-05-12",
    effectiveAt: 1778605200,
    summary:
      "Redemption Backstop v4 separates current executable capacity from eventual redeemability, adds fixed-USD capacity and size-aware costs, and makes route status, confidence, and effective-exit blending more explicit and conservative.",
    impact: [
      "Standalone route scoring now uses current executable capacity while `eventualRedeemabilityScore` preserves long-tail legal or protocol route quality as separate context",
      "Capacity profiles expose immediate, daily-limited, queued, eventual, and scoring capacity fields; fixed public USD buffers can be modeled without encoding arbitrary supply ratios",
      "Effective-exit blending now scales redemption uplift by modeled exit size, current capacity, confidence, and DEX/redemption correlation, with diversification bonus reserved for plausibly independent issuer rails",
      "Route-status evidence remains a four-hour snapshot from live-reserve metadata, reviewed static policy, and market-implied depeg overlays; no new outbound route-status fetches are added to the redemption sync",
      "Registry validation now runs through a shared manifest/validator, emits deterministic audit reports, and is paired with v4 active-gap and heuristic-route coverage audit tooling",
    ],
    commits: [],
    reconstructed: false,
  },
];
