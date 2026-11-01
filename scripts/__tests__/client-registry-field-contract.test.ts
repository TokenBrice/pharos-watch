import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildClientRegistryOutput,
  buildComplianceRegistryOutput,
  buildTelegramMiniAppCatalogOutput,
  buildWorkerRuntimeRegistryOutput,
  projectCoin,
  projectWorkerRuntimeCoin,
  projectDetailCoin,
  projectListCoin,
  projectBlacklistStatus,
  projectGeniusProfile,
  projectMintAuthorityStatus,
  validateGeniusComplianceProjection,
  validateListProjection,
} from "../build-data/build-client-registry.mjs";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { resolveMintAuthorityStatusKind } from "@shared/lib/classification/mint-authority";
import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import {
  GENIUS_COMPLIANCE_PROFILE_FIELDS,
  GENIUS_COMPLIANCE_SUMMARY_FIELDS,
  STABLECOIN_CLIENT_DETAIL_FIELDS,
  STABLECOIN_CLIENT_LIST_FIELDS,
} from "@shared/types/stablecoin-client-meta";
import type { StablecoinClientDetailMeta, StablecoinClientListMeta } from "@shared/types/stablecoin-client-meta";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";

describe("client registry field contract", () => {
  it("keeps compact yield taxonomy identical to every source and generated detail sidecar", () => {
    const { output, detailOutputs } = buildClientRegistryOutput();
    const list = JSON.parse(output) as StablecoinClientListMeta[];
    const details = new Map<string, StablecoinClientDetailMeta>(
      detailOutputs.map((entry: { id: string; output: string }) => [entry.id, JSON.parse(entry.output)]),
    );
    for (const source of TRACKED_SOURCE_COINS) {
      const compact = list.find((coin) => coin.id === source.id);
      expect(compact, source.id).toBeDefined();
      expect(compact?.yieldType, source.id).toBe(source.yieldConfig?.yieldType);
      expect(compact?.yieldType, source.id).toBe(details.get(source.id)?.yieldConfig?.yieldType);
    }
  });

  it("preserves an unclassified yield-bearing coin rather than inventing a yield type", () => {
    const coin = { id: "unknown-yield", flags: { yieldBearing: true } };
    expect(projectListCoin(coin, STABLECOIN_CLIENT_LIST_FIELDS, "core-stablecoin")).not.toHaveProperty("yieldType");
    expect(projectDetailCoin(coin, STABLECOIN_CLIENT_DETAIL_FIELDS)).not.toHaveProperty("yieldConfig");
  });

  it("retains typed native denomination rails in worker deployment projections", () => {
    const native = { kind: "native-denom", chain: "kava", address: "usdx", decimals: 6 };
    const receipt = { chain: "osmosis", address: "ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE", decimals: 6 };
    const projected = projectWorkerRuntimeCoin({
      id: "usdx-kava", symbol: "USDX", name: "USDX",
      flags: { pegCurrency: "USD", governance: "centralized-dependent" },
      contracts: [native, receipt], tradedContracts: [native],
    }, 0);
    expect(projected.contracts).toEqual([native, receipt]);
    expect(projected.tradedContracts).toEqual([native]);
  });

  it("retains full reserve inputs only for configured, non-suspended feeds", () => {
    const coin = {
      id: "reserve-test", symbol: "RES", name: "Reserve Test",
      flags: { pegCurrency: "USD", governance: "centralized", backing: "rwa", navToken: true },
      reserves: [{ name: "Treasuries", pct: 100, risk: "low", coinId: "usdc-circle" }],
      reserveReview: { reviewedAt: "2026-10-06", notes: "Reviewed reserve inputs" },
      liveReservesConfig: { adapter: "curated-validated", version: 1 },
    };
    const projected = projectWorkerRuntimeCoin(coin, 0);
    for (const field of ["flags", "reserves", "reserveReview", "liveReservesConfig"] as const) {
      expect(projected[field]).toEqual(coin[field]);
    }
    for (const config of [undefined, { ...coin.liveReservesConfig, suspended: true }]) {
      const unconfigured = projectWorkerRuntimeCoin({ ...coin, liveReservesConfig: config }, 0);
      expect(unconfigured).not.toHaveProperty("liveReservesConfig");
      expect(unconfigured).not.toHaveProperty("reserveReview");
      expect(unconfigured.flags).toEqual({ pegCurrency: "USD", governance: "centralized", navToken: true });
      expect(unconfigured.reserves).toEqual([{ risk: "low", pct: 100, coinId: "usdc-circle" }]);
    }
  });

  it.each(["sodax-sonic", "nest-vault-positions", "single-asset", "evm-branch-balances"])(
    "omits suspended %s reader provenance from list and detail projections",
    (adapter) => {
      const liveReservesConfig = { adapter, version: 1 };
      const coin = {
        id: "bnusd-balanced",
        liveReservesConfig: {
          ...liveReservesConfig,
          suspended: {
            reason: "The reader measures a different liability from the tracked asset.",
            since: "2026-10-08",
          },
        },
        reserves: [{ name: "Reviewed collateral", pct: 100, risk: "high" }],
      };
      for (const projected of [
        projectListCoin(coin, STABLECOIN_CLIENT_LIST_FIELDS, "core-stablecoin"),
        projectDetailCoin(coin, STABLECOIN_CLIENT_DETAIL_FIELDS),
      ]) {
        expect(projected).not.toHaveProperty("liveReserveAdapter");
        expect(projected).not.toHaveProperty("liveReservesConfig");
      }
      expect(projectDetailCoin(coin, STABLECOIN_CLIENT_DETAIL_FIELDS).reserves).toEqual(coin.reserves);
      const enabledCoin = { ...coin, liveReservesConfig };
      for (const projected of [
        projectListCoin(enabledCoin, STABLECOIN_CLIENT_LIST_FIELDS, "core-stablecoin") as StablecoinClientListMeta,
        projectDetailCoin(enabledCoin, STABLECOIN_CLIENT_DETAIL_FIELDS) as StablecoinClientDetailMeta,
      ]) {
        expect(projected.liveReserveAdapter).toBe(adapter);
      }
      expect(coin.liveReservesConfig.suspended).toBeDefined();
    },
  );

  it("omits every authored suspended reader from both generated client outputs", () => {
    const suspendedCoins = TRACKED_SOURCE_COINS.filter((coin) => coin.liveReservesConfig?.suspended);
    expect(suspendedCoins.map((coin) => coin.id)).toEqual(expect.arrayContaining([
      "bnusd-balanced", "inalpha-nest", "tgbp-tokenised", "usdxl-last",
    ]));
    const { output, detailOutputs } = buildClientRegistryOutput();
    const listCoins = JSON.parse(output) as StablecoinClientListMeta[];
    for (const sourceCoin of suspendedCoins) {
      const list = listCoins.find((coin) => coin.id === sourceCoin.id);
      const detailOutput = detailOutputs.find((entry: { id: string; output: string }) => entry.id === sourceCoin.id);
      expect(list).toBeDefined();
      expect(detailOutput).toBeDefined();
      const detail = JSON.parse(detailOutput!.output) as StablecoinClientDetailMeta;
      for (const projected of [list!, detail]) {
        expect(projected).not.toHaveProperty("liveReserveAdapter");
        expect(projected).not.toHaveProperty("liveReservesConfig");
      }
      expect(detail.reserves).toEqual(sourceCoin.reserves);
    }
  });

  it("rejects a length-preserving duplicate canonical ID before projecting either ordered output", ({ onTestFinished }) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "pharos-client-registry-order-"));
    onTestFinished(() => rmSync(fixtureDir, { recursive: true, force: true }));
    let projectionReads = 0;
    const sourceCoins = [
      {
        id: "kept",
        get symbol() {
          projectionReads += 1;
          return "KEPT";
        },
      },
      {
        id: "replaced",
        get symbol() {
          projectionReads += 1;
          return "REPLACED";
        },
      },
    ];
    const canonicalOrderJsonPath = join(fixtureDir, "canonical-order.json");
    writeFileSync(canonicalOrderJsonPath, JSON.stringify(["kept", "kept"]));

    for (const build of [buildClientRegistryOutput, buildWorkerRuntimeRegistryOutput]) {
      expect(() => build({ sourceCoins, canonicalOrderJsonPath })).toThrow(
        "canonical-order.json contains duplicate stablecoin ID",
      );
    }
    expect(projectionReads).toBe(0);
  });

  it("ranks the Mini App catalog by canonical market-cap order and skips frozen coins", ({ onTestFinished }) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "pharos-mini-app-catalog-order-"));
    onTestFinished(() => rmSync(fixtureDir, { recursive: true, force: true }));
    const coin = (id: string, status?: string) => ({ id, symbol: id.toUpperCase(), name: id, status, flags: { pegCurrency: "USD" } });
    const canonicalOrderJsonPath = join(fixtureDir, "canonical-order.json");
    writeFileSync(canonicalOrderJsonPath, JSON.stringify(["big", "gone", "small"]));

    const { searchableCoins } = buildTelegramMiniAppCatalogOutput({
      sourceCoins: [coin("small"), coin("gone", "frozen"), coin("big")],
      canonicalOrderJsonPath,
    });

    expect(searchableCoins.map((entry: { stablecoinId: string; rank: number }) => [entry.stablecoinId, entry.rank])).toEqual([["big", 1], ["small", 2]]);
  });

  it("marks wrapped and yield-bearing variants in the Mini App catalog", ({ onTestFinished }) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "pharos-mini-app-catalog-variant-"));
    onTestFinished(() => rmSync(fixtureDir, { recursive: true, force: true }));
    const canonicalOrderJsonPath = join(fixtureDir, "canonical-order.json");
    writeFileSync(canonicalOrderJsonPath, JSON.stringify(["base", "wrapper", "yield"]));

    const { searchableCoins } = buildTelegramMiniAppCatalogOutput({
      sourceCoins: [
        { id: "base", symbol: "BASE", name: "base", flags: { pegCurrency: "USD", yieldBearing: false } },
        { id: "wrapper", symbol: "WRAP", name: "wrapper", variantOf: "base", flags: { pegCurrency: "USD" } },
        { id: "yield", symbol: "YLD", name: "yield", flags: { pegCurrency: "USD", yieldBearing: true } },
      ],
      canonicalOrderJsonPath,
    });

    expect(searchableCoins.map((entry: { stablecoinId: string; variant: boolean }) => [entry.stablecoinId, entry.variant]))
      .toEqual([["base", false], ["wrapper", true], ["yield", true]]);
  });

  it("labels NAV-token catalog entries with the site hero peg label", ({ onTestFinished }) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "pharos-mini-app-catalog-nav-"));
    onTestFinished(() => rmSync(fixtureDir, { recursive: true, force: true }));
    const canonicalOrderJsonPath = join(fixtureDir, "canonical-order.json");
    writeFileSync(canonicalOrderJsonPath, JSON.stringify(["usde", "susde", "fpi", "usdc"]));

    const { searchableCoins } = buildTelegramMiniAppCatalogOutput({
      sourceCoins: [
        { id: "usde", symbol: "USDe", name: "Ethena USDe", flags: { pegCurrency: "USD", navToken: true } },
        { id: "susde", symbol: "sUSDe", name: "Staked USDe", pegReferenceId: "usde", flags: { pegCurrency: "USD", navToken: true } },
        { id: "fpi", symbol: "FPI", name: "Frax Price Index", flags: { pegCurrency: "VAR", navToken: true } },
        { id: "usdc", symbol: "USDC", name: "USD Coin", flags: { pegCurrency: "USD", navToken: false } },
      ],
      canonicalOrderJsonPath,
    });

    expect(searchableCoins.map((entry: { stablecoinId: string; pegLabel?: string }) => [entry.stablecoinId, entry.pegLabel]))
      .toEqual([["usde", "USD NAV"], ["susde", "USDe NAV"], ["fpi", "VAR NAV"], ["usdc", undefined]]);
    expect(searchableCoins[3]).not.toHaveProperty("pegLabel");
  });

  it("projects only the mint-authority coverage summary and excludes detail evidence", () => {
    const coin = {
      id: "minted-usd",
      name: "Minted USD",
      symbol: "MUSD",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Issuer minter can create supply through a documented role.",
        review: {
          sources: [{ label: "Docs", url: "https://example.com/docs" }],
          evidence: "Long reviewer evidence stays on the server-side metadata object.",
          reviewer: "pharos",
          reviewedAt: "2026-05-24",
          unresolvedQuestions: ["Should not ship"],
        },
        controls: [
          {
            chain: "ethereum",
            address: "0x0000000000000000000000000000000000000001",
            label: "Issuer minter",
            role: "direct-minter",
            authorityType: "safe",
            directMintAbility: "direct",
            threshold: 2,
            signerCount: 3,
            timelockDelaySec: 86_400,
            canRaiseCap: "unknown",
            capDescription: "Daily cap",
            modulesOrGuardsStatus: "none-detected",
            safe: {
              owners: ["0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"],
              source: "safe-api",
            },
            evidence: "Control-level evidence also stays server-side.",
            sources: [{ label: "Role", url: "https://example.com/role" }],
          },
        ],
      },
    };

    const projected = projectCoin(coin, STABLECOIN_CLIENT_LIST_FIELDS);

    expect(projected.mintAuthoritySummary).toEqual({
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "verified",
      controls: [
        {
          authorityType: "safe",
          directMintAbility: "direct",
          threshold: 2,
          signerCount: 3,
          timelockDelaySec: 86_400,
          canRaiseCap: "unknown",
          modulesOrGuardsStatus: "none-detected",
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("Issuer minter");
    expect(JSON.stringify(projected)).not.toContain("Long reviewer evidence");
    expect(JSON.stringify(projected)).not.toContain("Control-level evidence");
    expect(JSON.stringify(projected)).not.toContain("Should not ship");
    expect(JSON.stringify(projected)).not.toContain("Daily cap");
    expect(JSON.stringify(projected)).not.toContain("0x0000000000000000000000000000000000000001");
    expect(JSON.stringify(projected)).not.toContain("0x0000000000000000000000000000000000000002");
  });

  it.each(["unknown", "manual-review"] as const)("publishes Unknown for unresolved mint paths at %s confidence", (confidence) => {
    const mintAuthority = { mintPath: "unknown", authorityPosture: "unknown", confidence };
    const projected: Partial<StablecoinClientListMeta> = projectListCoin({ id: "unresolved", mintAuthority }, STABLECOIN_CLIENT_LIST_FIELDS, "core-stablecoin");
    expect(projected.mintAuthorityStatus).toBe("unknown");
    expect(projected.mintAuthoritySummary).toEqual(mintAuthority);
  });

  it("matches canonical mint status and effective archetype for every catalog row", () => {
    const { listCoins } = buildClientRegistryOutput();
    const sourceById = new Map(TRACKED_SOURCE_COINS.map((coin) => [coin.id, coin]));
    for (const source of TRACKED_SOURCE_COINS) {
      const projected = listCoins.find((coin: StablecoinClientListMeta) => coin.id === source.id);
      expect(projected.mintAuthorityStatus, source.id).toBe(source.mintAuthority
        ? resolveMintAuthorityStatusKind(source.mintAuthority) : undefined);
      expect(projected.mechanismArchetype, source.id).toBe(resolveMechanismArchetype(source, sourceById) ?? undefined);
    }
    const unresolvedIds = ["kag-kinesis", "kau-kinesis", "krw-kb-kookmin", "usdb-blast", "xdai-gnosis", "xo-exodus"];
    const unresolved = listCoins.filter((coin: StablecoinClientListMeta) => unresolvedIds.includes(coin.id));
    expect(unresolved).toHaveLength(6);
    expect(unresolved.every((coin: StablecoinClientListMeta) => coin.mintAuthorityStatus === "unknown")).toBe(true);
    expect(unresolved.filter((coin: StablecoinClientListMeta) => coin.status !== "pre-launch")).toHaveLength(5);
  });

  it.each([
    ["immutable-user-collateralized", "none-resolved-mint", [], "no-privileged-mint"],
    ["permissioned-minter", "bounded-admin", [], "governed-mint"],
    ["issuer-direct-mint", "bounded-admin", [], "issuer-or-backend-mint"],
    ["offchain-attested-minter", "bounded-admin", [], "issuer-or-backend-mint"],
    ["permissioned-minter", "bounded-admin", [{ authorityType: "eoa", directMintAbility: "direct" }], "issuer-or-backend-mint"],
  ] as const)("keeps the %s projection on the shared classifier branch", (mintPath, authorityPosture, controls, expected) => {
    const profile: MintAuthorityCoverageSummary = { mintPath, authorityPosture, confidence: "verified", controls: [...controls] };
    expect(projectMintAuthorityStatus({ mintAuthority: profile })).toBe(expected);
    expect(projectMintAuthorityStatus({ mintAuthority: profile })).toBe(resolveMintAuthorityStatusKind(profile));
  });

  it("omits missing-profile mint fields from the serialized browser contract", () => {
    const projected = JSON.parse(JSON.stringify(projectListCoin({ id: "unreviewed" }, STABLECOIN_CLIENT_LIST_FIELDS, "core-stablecoin")));
    expect(projected).not.toHaveProperty("mintAuthoritySummary");
    expect(projected).not.toHaveProperty("mintAuthorityStatus");
  });

  it("publishes every projection through the atomic writer and registers the helper as a source", () => {
    const script = readFileSync(resolve("scripts/build-data/build-client-registry.mjs"), "utf8");
    expect(script).toContain("atomicWriteFileSync");
    expect(script).not.toMatch(/\bwriteFileSync\b/);
    for (const id of ["stablecoin-catalog", "stablecoin-client-registry"]) {
      const artifact = GENERATED_ARTIFACT_REGISTRY.find((entry: { id: string }) => entry.id === id)!;
      expect(artifact.sourcePaths).toContain("scripts/lib/atomic-artifact-write.mts");
    }
  });

  it("loads the real classifier closure using the registered write/check transport", () => {
    const artifact = GENERATED_ARTIFACT_REGISTRY.find((entry: { id: string }) => entry.id === "stablecoin-client-registry")!;
    expect(artifact.checkCommand.split(" ")).toEqual([...artifact.command.split(" "), "--check"]);
    const [runtime, ...args] = artifact.command.split(" ");
    expect(runtime).toBe("node");
    const script = pathToFileURL(resolve(args.pop()!)).href;
    const output = execFileSync(process.execPath, [...args, "--input-type=module", "--eval", `
      import { projectMintAuthorityStatus } from ${JSON.stringify(script)};
      console.log(projectMintAuthorityStatus({ mintAuthority: {
        mintPath: "unknown", authorityPosture: "unknown", confidence: "manual-review"
      } }));
    `], { encoding: "utf8" });
    expect(output.trim()).toBe("unknown");
  });

  it.each([
    { mintPath: "wrapped-or-variant-inherited", status: "inherited-authority", inheritedFrom: "parent" },
    { mintPath: "bridge-or-oft-synthetic", status: "bridge-mint", inheritedFrom: undefined },
    { mintPath: "issuer-direct-mint", status: "multisig-mint", inheritedFrom: undefined },
  ])("publishes compact $status ahead of competing mint controls", ({ mintPath, status, inheritedFrom }) => {
    const projected = projectListCoin({
      id: "compact-mint",
      mintAuthority: {
        mintPath, authorityPosture: "bounded-admin", confidence: "verified", inheritedFrom,
        review: { evidence: "Private evidence" },
        controls: [{ authorityType: "safe", directMintAbility: "direct", threshold: 2, signerCount: 3 }],
      },
    }, STABLECOIN_CLIENT_LIST_FIELDS, "stablecoin") as StablecoinClientListMeta;
    expect(projected.mintAuthorityStatus).toBe(status);
    expect(projected.mintAuthoritySummary).toEqual({
      mintPath, authorityPosture: "bounded-admin", confidence: "verified",
      ...(inheritedFrom ? { inheritedFrom } : {}),
    });
    expect(projected).not.toHaveProperty("mintAuthority");
  });

  it.each([
    { parent: "classified", archetypeOverride: false, expected: "fiat-cash" },
    { parent: "unclassified", archetypeOverride: false, expected: undefined },
    { parent: "missing", archetypeOverride: false, expected: "synthetic-delta-neutral" },
    { parent: "classified", archetypeOverride: true, expected: "synthetic-delta-neutral" },
    { parent: "unclassified", archetypeOverride: true, expected: "synthetic-delta-neutral" },
    { parent: "missing", archetypeOverride: true, expected: "synthetic-delta-neutral" },
  ])("publishes canonical archetype with $parent parent and override=$archetypeOverride", ({ parent, archetypeOverride, expected }) => {
    const parentCoin = makeStablecoinMeta({ id: "parent", mechanismArchetype: parent === "classified" ? "fiat-cash" : undefined });
    const child = makeStablecoinMeta({
      id: "child", variantOf: "parent", variantKind: "savings-passthrough",
      mechanismArchetype: "synthetic-delta-neutral", archetypeOverride,
    });
    const registry = new Map(parent === "missing" ? [] : [[parentCoin.id, parentCoin]]);
    const projected: Partial<StablecoinClientListMeta> = projectListCoin(child, STABLECOIN_CLIENT_LIST_FIELDS, "stablecoin-variant", registry);
    expect(projected.mechanismArchetype).toBe(expected);
    expect(projected.mechanismArchetype).toBe(resolveMechanismArchetype(child, registry) ?? undefined);
    if (expected === undefined) expect(JSON.parse(JSON.stringify(projected))).not.toHaveProperty("mechanismArchetype");
    expect(projected.variantOf).toBe("parent");
    expect(() => validateListProjection(projected, child, 0, STABLECOIN_CLIENT_LIST_FIELDS, "stablecoin-variant", registry)).not.toThrow();
  });

  it("projects only the reviewed blacklist status and excludes review evidence", () => {
    const coin = {
      id: "freezable-usd",
      name: "Freezable USD",
      symbol: "FUSD",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      blacklistabilityReview: {
        reviewedStatus: "inherited",
        sources: [{ label: "Docs", url: "https://example.com/blacklist" }],
        evidence: "Long blacklist review evidence stays server-side.",
        reviewer: "pharos",
        reviewedAt: "2026-05-24",
      },
    };

    const projected = projectCoin(coin, STABLECOIN_CLIENT_LIST_FIELDS);

    expect(projectBlacklistStatus(coin)).toBe("inherited");
    expect(projected.blacklistStatus).toBe("inherited");
    expect(JSON.stringify(projected)).not.toContain("Long blacklist review evidence");
    expect(JSON.stringify(projected)).not.toContain("https://example.com/blacklist");
    expect(JSON.stringify(projected)).not.toContain("2026-05-24");
  });

  it("keeps full GENIUS evidence in per-coin detail and omits it from the compliance summary", () => {
    const coin = {
      id: "genius-usd",
      name: "GENIUS USD",
      symbol: "GUSD",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      genius: {
        applicability: "apparent-payment-stablecoin",
        applicabilityBasis: {
          summary: "Long applicability basis loads with per-coin detail.",
        },
        authorizationStatus: "no-public-authorization-found",
        issuerPathway: "unknown",
        issuerEntity: "Fixture Issuer",
        issuerDomicile: "United States",
        licensingRegulator: "OCC",
        primaryFederalRegulator: "OCC",
        stateRegulator: "NYDFS",
        foreignExceptionStatus: "not-applicable",
        foreignExceptionEvidence: {
          summary: "Foreign exception posture is not applicable for a domestic issuer.",
          references: [
            {
              label: "Foreign exception source",
              url: "https://example.com/foreign-exception",
              sourceKind: "federal-regulator",
            },
          ],
        },
        enforcementStatus: "no-public-action-found",
        daspOfferSaleStatus: "not-yet-restricted",
        reserveDisclosurePresent: true,
        reserveDisclosureUrl: "https://example.com/reserves",
        redemptionPolicyPresent: true,
        monthlyAttestationPresent: true,
        notes: "Rendered compliance note.",
        references: [{ label: "Disclosure", url: "https://example.com/genius", sourceKind: "issuer-disclosure" }],
        negativeEvidenceReview: {
          sourcesChecked: ["OCC public releases"],
          summary: "Long negative evidence review loads with per-coin detail.",
          reviewer: "pharos",
          reviewedAt: "2026-05-27",
        },
        reviewer: "pharos",
        reviewedAt: "2026-05-27",
      },
    };

    const projected = projectDetailCoin(coin, STABLECOIN_CLIENT_DETAIL_FIELDS);
    const complianceProfile = projectGeniusProfile(coin.genius, GENIUS_COMPLIANCE_PROFILE_FIELDS);
    const { complianceEntries } = buildComplianceRegistryOutput({ sourceCoins: [coin] });
    const summary = complianceEntries[0].genius;
    expect(summary).toEqual(projectGeniusProfile(coin.genius, GENIUS_COMPLIANCE_SUMMARY_FIELDS));
    expect(summary.authorizationStatus).toBe("no-public-authorization-found");
    for (const field of ["references", "negativeEvidenceReview", "applicabilityBasis", "notes"]) {
      expect(summary).not.toHaveProperty(field);
      expect(projected.genius).toHaveProperty(field);
    }
    expect(() => validateGeniusComplianceProjection(complianceEntries[0], coin, 0)).not.toThrow();
    expect(() => validateGeniusComplianceProjection(
      { ...complianceEntries[0], genius: { ...summary, notes: coin.genius.notes } }, coin, 0,
    )).toThrow("genius profile diverges from source");

    expect(projectGeniusProfile(null)).toBeNull();
    expect(projected.genius).toEqual(complianceProfile);
    expect(complianceProfile).toEqual({
      applicability: "apparent-payment-stablecoin",
      applicabilityBasis: {
        summary: "Long applicability basis loads with per-coin detail.",
      },
      authorizationStatus: "no-public-authorization-found",
      issuerPathway: "unknown",
      issuerEntity: "Fixture Issuer",
      issuerDomicile: "United States",
      licensingRegulator: "OCC",
      primaryFederalRegulator: "OCC",
      stateRegulator: "NYDFS",
      foreignExceptionStatus: "not-applicable",
      foreignExceptionEvidence: {
        summary: "Foreign exception posture is not applicable for a domestic issuer.",
        references: [
          {
            label: "Foreign exception source",
            url: "https://example.com/foreign-exception",
            sourceKind: "federal-regulator",
          },
        ],
      },
      enforcementStatus: "no-public-action-found",
      daspOfferSaleStatus: "not-yet-restricted",
      reserveDisclosurePresent: true,
      reserveDisclosureUrl: "https://example.com/reserves",
      redemptionPolicyPresent: true,
      monthlyAttestationPresent: true,
      notes: "Rendered compliance note.",
      references: [{ label: "Disclosure", url: "https://example.com/genius", sourceKind: "issuer-disclosure" }],
      negativeEvidenceReview: {
        sourcesChecked: ["OCC public releases"],
        summary: "Long negative evidence review loads with per-coin detail.",
        reviewer: "pharos",
        reviewedAt: "2026-05-27",
      },
      reviewer: "pharos",
      reviewedAt: "2026-05-27",
    });
  });
});
