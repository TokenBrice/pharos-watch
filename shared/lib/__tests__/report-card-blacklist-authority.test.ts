import { describe, expect, it } from "vitest";
import { TRACKED_STABLECOINS } from "../stablecoins";
import { createBlacklistResolutionContext, resolveBlacklistStatus, resolveBlacklistStatuses } from "../report-cards";

function deterministicShuffle<T>(values: readonly T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = (i * 17 + 11) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe("report-card blacklist authority", () => {
  it("pins direct freeze and blacklist corrections from the unfreezable audit", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.get("jupusd-jupiter")).toBe(true);
    expect(resolved.get("mai-qidao")).toBe(true);
    expect(resolved.get("suiusde-sui")).toBe(true);
    expect(resolved.get("jusd-jusd-stable-token")).toBe(true);
    expect(resolved.get("usda-alpha-partner")).toBe(true);
    expect(resolved.get("doc-money-on-chain")).toBe(true);
    expect(resolved.get("usdrif-rif")).toBe(true);
    expect(resolved.get("usdr-ring")).toBe(true);
    expect(resolved.get("inalpha-nest")).toBe(true);
    expect(resolved.get("sbold-k3-capital")).toBe("possible");
    expect(resolved.get("cdp-enosys")).toBe("possible");
  });

  it("pins the follow-up audit for disputed unfreezable classifications", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.get("home-homecoin")).toBe("possible");
    // HBD: Hive witness consensus executed `hardfork_hive_operation` in HF23
    // (March 2020) moving ~64 accounts' HIVE/HBD balances to @hive.fund —
    // chain-native seizure precedent.
    expect(resolved.get("hbd-hive")).toBe(true);
    // vCRED: plain Ownable ERC20 with unbounded `mint(...) onlyOwner` on Hemi.
    // No freeze on existing balances, but owner can dilute holders without
    // bound — classified as "dilutable".
    expect(resolved.get("vcred-vcred")).toBe("dilutable");
    expect(resolved.get("fusd-freedom-dollar")).toBe(false);
    // LUAUSD: `UtilityToken` on Arbitrum is Ownable with unbounded `mint`
    // plus `burnFrom`. Same dilution-risk reasoning as vCRED.
    expect(resolved.get("luausd-lumi-finance")).toBe("dilutable");
    // NXUSD: BoringOwnable with mint rate-limited to 15%/24h and no admin
    // reach into user balances. Bounded enough to remain a defensible "No".
    expect(resolved.get("nxusd-nereus")).toBe(false);
  });

  it("pins the May 2026 unfreezable audit (upgradeable-proxy + admin-mint corrections)", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    // Midas mRe7YIELD: TransparentUpgradeableProxy with `Blacklistable.sol`,
    // `MidasAccessControl.sol`, and `ERC20PausableUpgradeable` in source tree.
    expect(resolved.get("mre7yield-midas")).toBe(true);
    // Felix feUSD on Hyperliquid: TransparentUpgradeableProxy. Project docs
    // cite "Admin Parameter Controls" and "Emergency Pausing" as features.
    expect(resolved.get("feusd-felix")).toBe(true);
    // Quill USDQ on Scroll: deployed token is an upgradeable proxy
    // (GoPlus is_proxy: 1), so admin can swap implementation to add freeze.
    expect(resolved.get("usdq-quill")).toBe(true);
    // Orki USDK on Swellchain: EIP1967 proxy with unverified implementation.
    expect(resolved.get("usdk-orki")).toBe(true);
    // srUSD: AccessControl with DEFAULT_ADMIN_ROLE able to grant MINTER —
    // no token-level freeze but unbounded mint-grant capability → "dilutable".
    expect(resolved.get("srusd-reservoir")).toBe("dilutable");
    // BabelFish XUSD: upgradeable mAsset + multisig with pause history;
    // explicit `false` override removed so reserve inheritance (32% bridged
    // USDT, 14% bridged USDC) now flows through.
    expect(resolved.get("xusd-babelfish")).toBe("inherited");
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
      [...resolved.entries()]
        .filter(([, status]) => status === true || status === "inherited")
        .map(([id]) => id),
    );
    const trackedMetaById = new Map(TRACKED_STABLECOINS.map((meta) => [meta.id, meta] as const));
    const context = createBlacklistResolutionContext(blacklistableIds, trackedMetaById);

    for (const meta of TRACKED_STABLECOINS) {
      expect(resolveBlacklistStatus(meta, { context, reserveSlices: meta.reserves })).toBe(resolved.get(meta.id));
    }
  });
});
