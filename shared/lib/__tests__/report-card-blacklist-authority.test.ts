import { describe, expect, it } from "vitest";
import { TRACKED_STABLECOINS } from "../stablecoins/registry";
import {
  createBlacklistResolutionContext,
  enrichLiveSlicesForBlacklist,
  isBlacklistable,
  resolveBlacklistStatus,
  resolveBlacklistStatuses,
} from "../report-cards";

const EXPECTED_RETIRED_DILUTABLE_UPSTREAM_IDS = [
  "crvusd-curve",
  "dai-makerdao",
  "jpyt-dephaser",
  "pht-pht",
  "reusd-resupply",
  "srusd-reservoir",
  "usdd-tron-dao-reserve",
  "usdu-unitas",
] as const;

function deterministicShuffle<T>(values: readonly T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = (i * 17 + 11) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeMeta(id: string, overrides: Record<string, unknown> = {}): never {
  return {
    id,
    name: id,
    symbol: id.slice(0, 5).toUpperCase(),
    flags: {
      backing: "crypto-backed",
      pegCurrency: "USD",
      governance: "decentralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  } as never;
}

describe("report-card blacklist authority", () => {
  it("pins direct freeze and blacklist corrections from the unfreezable audit", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.get("jupusd-jupiter")).toBe(true);
    expect(resolved.get("mai-qidao")).toBe(true);
    expect(resolved.get("suiusde-sui")).toBe(true);
    expect(resolved.get("jusd-jusd-stable-token")).toBe(true);
    expect(resolved.get("usda-alpha-partner")).toBe(true);
    // doc-money-on-chain: re-audited down to "possible" in the metadata backfill.
    expect(resolved.get("doc-money-on-chain")).toBe("possible");
    expect(resolved.get("usdrif-rif")).toBe(true);
    expect(resolved.get("usdr-ring")).toBe(true);
    expect(resolved.get("inalpha-nest")).toBe(true);
    expect(resolved.get("sbold-k3-capital")).toBe("possible");
    // cdp-enosys: re-audited up to a resolved Yes — owner can register burn/forced-transfer callers.
    expect(resolved.get("cdp-enosys")).toBe(true);
  });

  it("pins the follow-up audit for disputed unfreezable classifications", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.get("home-homecoin")).toBe("possible");
    // HBD: Hive witness consensus executed `hardfork_hive_operation` in HF23
    // (March 2020) moving ~64 accounts' HIVE/HBD balances to @hive.fund —
    // chain-native seizure precedent.
    expect(resolved.get("hbd-hive")).toBe(true);
    // vCRED: plain Ownable ERC20 with mint authority but no freeze, blacklist,
    // pause, seize, or arbitrary burn surface under FreezeWatch semantics.
    expect(resolved.get("vcred-vcred")).toBe(false);
    expect(resolved.get("fusd-freedom-dollar")).toBe(false);
    // LUAUSD: no direct token freeze, but Lumi materials describe stablecoin
    // reserves, so FreezeWatch resolves reserve-side exposure upstream.
    expect(resolved.get("luausd-lumi-finance")).toBe("inherited");
    // NXUSD: no direct token freeze, but Nereus materials include DAI in the
    // collateral set, so the DAI path resolves upstream.
    expect(resolved.get("nxusd-nereus")).toBe("inherited");
    // HCHF: Hedera token metadata has no admin/freeze/wipe/pause key.
    // The supply key is used by HLiquity's collateralized CDP mint path, not
    // treated as standalone unbounded admin dilution authority.
    expect(resolved.get("hchf-hedera-swiss-franc")).toBe(false);
  });

  it("pins the May 2026 unfreezable audit (upgradeable-proxy + admin-mint corrections)", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    // Midas mRe7YIELD: TransparentUpgradeableProxy with `Blacklistable.sol`,
    // `MidasAccessControl.sol`, and `ERC20PausableUpgradeable` in source tree.
    expect(resolved.get("mre7yield-midas")).toBe(true);
    // Felix feUSD on Hyperliquid: TransparentUpgradeableProxy. Project docs
    // cite "Admin Parameter Controls" and "Emergency Pausing" as features.
    expect(resolved.get("feusd-felix")).toBe(true);
    // Quill USDQ on Scroll: no direct blacklist confirmed, but the token is a
    // mutable EIP-1967/UUPS-style proxy behind AccessManager authority.
    expect(resolved.get("usdq-quill")).toBe("possible");
    // Orki USDK on Swellchain: no direct blacklist confirmed, but the token is
    // a mutable EIP-1967 proxy behind Orki AccessManager authority.
    expect(resolved.get("usdk-orki")).toBe("possible");
    // srUSD: wrapper over rUSD; freeze exposure now resolves through the parent
    // balance sheet and PSM path, while mint authority is assessed separately.
    expect(resolved.get("srusd-reservoir")).toBe("inherited");
    // BabelFish XUSD: upgradeable mAsset + multisig with pause history;
    // explicit `false` override removed so reserve inheritance (32% bridged
    // USDT, 14% bridged USDC) now flows through.
    expect(resolved.get("xusd-babelfish")).toBe("inherited");
  });

  it("pins the May 25 2026 full unfreezable re-audit", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.get("m-m0")).toBe(true);
    expect(resolved.get("isc-international-stable-currency")).toBe(true);
    expect(resolved.get("usg-tangent")).toBe(true);
    // dllr-sovryn: re-audited up to a resolved Yes — manager-gated burn plus an
    // owner-settable MassetManager proxy establish direct holder intervention.
    expect(resolved.get("dllr-sovryn")).toBe(true);
    expect(resolved.get("fxd-fathom")).toBe("possible");
    expect(resolved.get("cjpy-yamato")).toBe("possible");
    // jusd-juicedollar: TERRA re-review confirmed the verified Citrea JUSD source
    // exposes no native holder freeze/blacklist and added a reviewed
    // upstreamSuppressionRationale, so USDC.e/USDT.e/ctUSD reserve exposure no
    // longer propagates as inheritance.
    expect(resolved.get("jusd-juicedollar")).toBe(false);
    expect(resolved.get("silk-shade-protocol")).toBe("inherited");
    // bnusd-balanced: re-audited up to a resolved Yes — the canonical bnUSD SCORE
    // exposes a Governance-only govTransfer that moves balances from arbitrary
    // source addresses, a direct holder-control surface above reserve inheritance.
    expect(resolved.get("bnusd-balanced")).toBe(true);
  });

  it("pins the retired Dilutable cohort under freeze-only semantics", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    for (const id of EXPECTED_RETIRED_DILUTABLE_UPSTREAM_IDS) {
      expect(resolved.get(id)).toBe("inherited");
    }

    // USDe left the inherited-only cohort after the reviewed TON deployment
    // established an administrator-controlled wallet lock path.
    expect(resolved.get("usde-ethena")).toBe(true);
    expect(resolved.get("luausd-lumi-finance")).toBe("inherited");
    // usdn-smardex: TERRA re-review of the verified Ethereum USDN source found no
    // direct holder freeze/blacklist and added a reviewed suppression (same-symbol
    // false positive vs the unrelated Noble USDN), re-graded to direct false.
    expect(resolved.get("usdn-smardex")).toBe(false);
    expect(resolved.get("vcred-vcred")).toBe(false);
    // fpi-frax: TERRA re-review found an owner-controlled ProxyAdmin upgrade path
    // on Fraxtal (upgrade-control, not active freeze), re-graded to "possible".
    expect(resolved.get("fpi-frax")).toBe("possible");
    // xai-silo-finance: TERRA re-review of the sole verified Ethereum XAI source
    // found no holder-transfer control and added a reviewed suppression, so USDC
    // Silo collateral no longer propagates as inheritance.
    expect(resolved.get("xai-silo-finance")).toBe(false);

    for (const meta of TRACKED_STABLECOINS) {
      expect(meta.canBeBlacklisted).not.toBe("dilutable");
      expect("canBeBlacklistedSource" in meta).toBe(false);
    }
  });

  it("keeps blacklist resolution stable across full-registry ordering changes", () => {
    const canonical = resolveBlacklistStatuses(TRACKED_STABLECOINS);
    const reversed = resolveBlacklistStatuses([...TRACKED_STABLECOINS].reverse());
    const shuffled = resolveBlacklistStatuses(deterministicShuffle(TRACKED_STABLECOINS));

    expect(reversed).toEqual(canonical);
    expect(shuffled).toEqual(canonical);
  });

  it("keeps batch and singleton resolution aligned when using the same resolved context", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);
    const blacklistableIds = new Set(
      [...resolved.entries()].filter(([, status]) => status === true || status === "inherited").map(([id]) => id),
    );
    const trackedMetaById = new Map(TRACKED_STABLECOINS.map((meta) => [meta.id, meta] as const));
    const context = createBlacklistResolutionContext(blacklistableIds, trackedMetaById);

    for (const meta of TRACKED_STABLECOINS) {
      expect(resolveBlacklistStatus(meta, { context, reserveSlices: meta.reserves })).toBe(resolved.get(meta.id));
    }
  });

  it("propagates upstream exposure from any positive reserve share", () => {
    const resolved = resolveBlacklistStatuses([
      makeMeta("direct", {
        flags: {
          backing: "rwa-backed",
          pegCurrency: "USD",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      }),
      makeMeta("downstream", {
        reserves: [
          { name: "Direct stablecoin dust", pct: 0.1, risk: "low", coinId: "direct" },
          { name: "ETH", pct: 99.9, risk: "very-low" },
        ],
      }),
    ]);

    expect(resolved.get("downstream")).toBe("inherited");
  });

  it("keeps singleton helper context and live-slice enrichment aligned", () => {
    const direct = makeMeta("direct", {
      symbol: "DRT",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
    });
    const blacklistableIds = new Set(["direct"]);
    const enriched = enrichLiveSlicesForBlacklist(
      [{ name: "DRT sleeve", pct: 1, risk: "low" }],
      blacklistableIds,
      new Map([["direct", direct]]),
    );

    expect(enriched[0].blacklistable).toBe(true);
    expect(isBlacklistable(makeMeta("downstream"), blacklistableIds, enriched)).toBe("inherited");
  });

  it("separates variant inheritance for possible, direct, and upstream parents", () => {
    const metas = [
      makeMeta("possible-parent", { canBeBlacklisted: "possible" }),
      makeMeta("possible-child", {
        variantOf: "possible-parent",
        variantKind: "savings-passthrough",
        pegReferenceId: "possible-parent",
        flags: {
          backing: "crypto-backed",
          pegCurrency: "USD",
          governance: "centralized-dependent",
          yieldBearing: true,
          rwa: false,
          navToken: true,
        },
      }),
      makeMeta("direct-parent", {
        flags: {
          backing: "rwa-backed",
          pegCurrency: "USD",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      }),
      makeMeta("direct-child", {
        variantOf: "direct-parent",
        variantKind: "savings-passthrough",
        pegReferenceId: "direct-parent",
        flags: {
          backing: "rwa-backed",
          pegCurrency: "USD",
          governance: "centralized-dependent",
          yieldBearing: true,
          rwa: true,
          navToken: true,
        },
      }),
      makeMeta("upstream-parent", {
        reserves: [{ name: "USDC", pct: 1, risk: "low", coinId: "direct-parent" }],
      }),
      makeMeta("upstream-child", {
        variantOf: "upstream-parent",
        variantKind: "savings-passthrough",
        pegReferenceId: "upstream-parent",
        flags: {
          backing: "crypto-backed",
          pegCurrency: "USD",
          governance: "centralized-dependent",
          yieldBearing: true,
          rwa: false,
          navToken: true,
        },
      }),
    ];

    const resolved = resolveBlacklistStatuses(metas);

    expect(resolved.get("possible-child")).toBe("possible");
    expect(resolved.get("direct-child")).toBe("inherited");
    expect(resolved.get("upstream-child")).toBe("inherited");
  });

  it("requires reviewed rationale before explicit false suppresses upstream exposure", () => {
    const direct = makeMeta("direct", {
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
    });
    const withoutRationale = makeMeta("without-rationale", {
      canBeBlacklisted: false,
      reserves: [{ name: "Direct stablecoin", pct: 1, risk: "low", coinId: "direct" }],
    });
    const withRationale = makeMeta("with-rationale", {
      canBeBlacklisted: false,
      blacklistabilityReview: {
        reviewedStatus: false,
        sourceFreeRationale: "fixture",
        evidence: "Fixture evidence for upstream suppression.",
        reviewer: "Fixture",
        reviewedAt: "2026-05-12",
        upstreamSuppressionRationale: "Reviewed fixture suppression rationale.",
      },
      reserves: [{ name: "Direct stablecoin", pct: 1, risk: "low", coinId: "direct" }],
    });

    const resolved = resolveBlacklistStatuses([direct, withoutRationale, withRationale]);

    expect(resolved.get("without-rationale")).toBe("inherited");
    expect(resolved.get("with-rationale")).toBe(false);
  });
});
