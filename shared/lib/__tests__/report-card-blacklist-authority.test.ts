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
  "reusd-resupply",
  "srusd-reservoir",
  "usdd-tron-dao-reserve",
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
    // sbold-k3-capital: the C07 exact-source review (2026-08-08, Ethereum block
    // 25712319) re-graded the earlier "possible" down to a resolved No — the
    // owner pause gates deposit/mint/withdraw/redeem/swap only, while sBOLD
    // transfer/transferFrom stay unmodified ERC-20 paths.
    expect(resolved.get("sbold-k3-capital")).toBe(false);
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
    // Quill USDQ on Scroll: re-audited up to a resolved Yes by C11 (Scroll block
    // 34599130). Transfers carry no blacklist branch, but the configured
    // CollateralRegistry/BorrowerOperations/TroveManager/StabilityPool
    // components hold allowance-free burn(address,uint256) over arbitrary
    // balances — a live privileged holder-burn primitive.
    expect(resolved.get("usdq-quill")).toBe(true);
    // Orki USDK on Swellchain: no direct blacklist confirmed, but the token is
    // a mutable EIP-1967 proxy behind Orki AccessManager authority.
    expect(resolved.get("usdk-orki")).toBe("possible");
    // srUSD: wrapper over rUSD; freeze exposure now resolves through the parent
    // balance sheet and PSM path, while mint authority is assessed separately.
    expect(resolved.get("srusd-reservoir")).toBe("inherited");
    // BabelFish XUSD: C08 (Rootstock block 9134338) resolved this above reserve
    // inheritance to a direct Yes — the owner-only burn(address,uint256) held by
    // manager proxy 0x1440d194... destroys a supplied holder balance without
    // allowance.
    expect(resolved.get("xusd-babelfish")).toBe(true);
  });

  it("pins the May 25 2026 full unfreezable re-audit", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.get("m-m0")).toBe(true);
    expect(resolved.get("isc-international-stable-currency")).toBe(true);
    expect(resolved.get("usg-tangent")).toBe(true);
    // dllr-sovryn: re-audited up to a resolved Yes — manager-gated burn plus an
    // owner-settable MassetManager proxy establish direct holder intervention.
    expect(resolved.get("dllr-sovryn")).toBe(true);
    // fxd-fathom: the 2026-08-09 AF01 re-review (verified FV-A, ProxyAdmin
    // owner re-read on-chain) supersedes C09's "inherited": the CGO sleeve the
    // upstream resolution rested on is now 0.001% of collateral and the
    // remaining reserves are XDC-family with no freezable stablecoin, so the
    // material exposure is the single-EOA ProxyAdmin upgrade path — "possible".
    expect(resolved.get("fxd-fathom")).toBe("possible");
    // cjpy-yamato: C10 (Ethereum block 25712439) re-audited up to a resolved Yes
    // — the bound CurrencyOS can call burn(address,uint256) without allowance
    // and its 2-of-4 governance Safe can register Yamato callers.
    expect(resolved.get("cjpy-yamato")).toBe(true);
    // jusd-juicedollar: the later cohort recheck preserved the direct No finding
    // but removed the incorrect suppression of its live USDT.e bridge reserve.
    expect(resolved.get("jusd-juicedollar")).toBe("inherited");
    // silk-shade-protocol: C11 (Secret block 26592492) resolved the reserve-only
    // reading up to a direct Yes — the pinned SNIP-20/25 implementation exposes
    // admin `SetContractStatus` StopAllButRedeems/StopAll, a system-wide holder
    // transfer stop held by a 5-of-7 multisig.
    expect(resolved.get("silk-shade-protocol")).toBe(true);
    // bnusd-balanced: re-audited up to a resolved Yes — the canonical bnUSD SCORE
    // exposes a Governance-only govTransfer that moves balances from arbitrary
    // source addresses, a direct holder-control surface above reserve inheritance.
    expect(resolved.get("bnusd-balanced")).toBe(true);
  });

  it("pins the August 8 2026 unfreezable-cohort corrections", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    for (const id of [
      "brlm-mento",
      "buck-bucket-protocol",
      "frax-frax",
      "hyusd-hylo",
      "jusd-juicedollar",
      "lisusd-lista",
      "sdola-inverse-finance",
      "usd3-reserve-protocol",
      "usdaf-asymmetry",
      "usdh-hubble",
      "xdai-gnosis",
    ]) {
      expect(resolved.get(id)).toBe("inherited");
    }

    // usdxl-last / yzusd-yuzu: the C07 and C04 reviews replaced the unresolvable
    // upstream identity with an explicit direct verdict. Both tokens have
    // unrestricted current transfer paths but a live logic-replacement Safe (and
    // for yzUSD, undocumented Sentinel wallet blocking), so "possible" is the
    // honest bounded direct grade and it outranks the reserve inference.
    expect(resolved.get("usdxl-last")).toBe("possible");
    expect(resolved.get("yzusd-yuzu")).toBe("possible");
    // ousd-origin-protocol: C06 (Ethereum block 25712273) found a live
    // Vault-only burn(address,uint256) arbitrary-holder destruction primitive.
    expect(resolved.get("ousd-origin-protocol")).toBe(true);
    // usdx-kava: C06 (Kava height 22013136) found Kava wires governance into the
    // bank keeper, so MsgSetSendEnabled can globally disable `usdx` sends.
    expect(resolved.get("usdx-kava")).toBe(true);
    expect(resolved.get("zchf-frankencoin")).toBe("possible");
    expect(resolved.get("uusd-youves")).toBe(true);
  });

  it("pins the retired Dilutable cohort under freeze-only semantics", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    for (const id of EXPECTED_RETIRED_DILUTABLE_UPSTREAM_IDS) {
      expect(resolved.get(id)).toBe("inherited");
    }

    // USDe left the inherited-only cohort after the reviewed TON deployment
    // established an administrator-controlled wallet lock path.
    expect(resolved.get("usde-ethena")).toBe(true);
    // usdu-unitas: C04 replaced the unresolvable upstream identity with a direct
    // Yes — Unipay's terms reserve the right to freeze, burn, or restrict USDu
    // without prior notice, which FreezeWatch treats as issuer-level authority.
    expect(resolved.get("usdu-unitas")).toBe(true);
    // pht-pht: C07 left the direct grade honestly bounded at "possible" — the
    // material Tron deployment is unverified, and the Polygon UUPS proxy owner
    // can replace an otherwise unrestricted implementation.
    expect(resolved.get("pht-pht")).toBe("possible");
    expect(resolved.get("luausd-lumi-finance")).toBe("inherited");
    // usdn-smardex: TERRA re-review of the verified Ethereum USDN source found no
    // direct holder freeze/blacklist and added a reviewed suppression (same-symbol
    // false positive vs the unrelated Noble USDN), re-graded to direct false.
    expect(resolved.get("usdn-smardex")).toBe(false);
    expect(resolved.get("vcred-vcred")).toBe(false);
    // fpi-frax: C06 re-reviewed every live deployment (Ethereum block 25712273,
    // Fraxtal block 39703046, ZKsync canonical) and found no holder restriction,
    // moving the Fraxtal ProxyAdmin upgrade path to the restrictable transfer
    // posture. Its FRAX/AMO reserve leg still carries freezable upstream
    // exposure, so FreezeWatch resolves it upstream rather than as a direct No.
    expect(resolved.get("fpi-frax")).toBe("inherited");
    // DUSD: the MachineShare token has no reviewed local holder freeze path.
    // The blacklist surface is inherited from the USDC accounting-token
    // exposure, while AsyncRedeemer access gating is modeled separately as
    // redemption access rather than transfer blacklistability.
    expect(resolved.get("dusd-dialectic")).toBe("inherited");
    const dusd = TRACKED_STABLECOINS.find((meta) => meta.id === "dusd-dialectic");
    const dusdEvidence = dusd?.blacklistabilityReview?.evidence ?? "";
    expect(dusdEvidence).toContain("Recovery Mode");
    expect(dusdEvidence).toContain("cannot move Circle-frozen USDC");
    expect(dusdEvidence).toContain("transferring DUSD before a request to a newly verified wallet");
    expect(dusdEvidence).toContain("request-NFT transferability and post-transfer claim behavior");
    expect(dusdEvidence).toContain("no observed contract-level expiry");
    expect(dusdEvidence).toContain("no guaranteed remediation or alternate settlement asset");
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
