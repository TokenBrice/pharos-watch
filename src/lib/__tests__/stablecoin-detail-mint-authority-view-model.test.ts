import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import type {
  MintAuthorityClientControlSummary,
  MintAuthorityClientSummary,
} from "@shared/types/stablecoin-client-meta";
import {
  buildMintAuthorityDetailViewModel,
  type MintAuthorityDetailControlViewModel,
} from "../stablecoin-detail-mint-authority-view-model";
import { buildStablecoinDetailClientCoin, type StablecoinDetailCoinMeta } from "../stablecoin-detail-client-coin";

function makeMintAuthorityCoin(
  summary: MintAuthorityClientSummary,
  overrides: Partial<StablecoinDetailCoinMeta> = {},
): StablecoinDetailCoinMeta {
  return {
    ...makeStablecoinMeta({ id: "mint-authority-fixture" }),
    mintAuthoritySummary: summary,
    ...overrides,
  };
}

function makeControlCoin(control: MintAuthorityClientControlSummary): StablecoinDetailCoinMeta {
  return makeMintAuthorityCoin({
    mintPath: "permissioned-minter",
    authorityPosture: "bounded-admin",
    confidence: "verified",
    summary: "Minting is controlled by published admin accounts.",
    controls: [control],
  });
}

describe("mint-authority detail view-model builder", () => {
  it("uses only compact mint-authority summaries for client detail presentation", () => {
    const fullCoin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(fullCoin?.mintAuthority).toBeDefined();
    const coinWithServerOnlyResearch = {
      ...fullCoin!,
      blacklistabilityReview: { sentinel: true } as never,
      bridgeRouteRisk: { sentinel: true } as never,
      custodyProfile: { sentinel: true } as never,
      dependencyReview: { sentinel: true } as never,
      implementationLaunchDate: "2026-01-01",
      mechanismArchetypeReview: { sentinel: true } as never,
      oracleRisk: { sentinel: true } as never,
      reserveReview: { sentinel: true } as never,
    };
    const clientCoin = buildStablecoinDetailClientCoin(coinWithServerOnlyResearch);

    expect(buildMintAuthorityDetailViewModel(fullCoin!).status).toBe("not-reviewed");
    for (const serverOnlyField of [
      "blacklistabilityReview",
      "bridgeRouteRisk",
      "custodyProfile",
      "dependencyReview",
      "implementationLaunchDate",
      "mechanismArchetypeReview",
      "mintAuthority",
      "oracleRisk",
      "reserveReview",
    ]) {
      expect(serverOnlyField in coinWithServerOnlyResearch).toBe(true);
      expect(serverOnlyField in clientCoin).toBe(false);
    }
    expect(clientCoin.mintAuthoritySummary).toBeDefined();
    expect(buildMintAuthorityDetailViewModel(clientCoin).status).toBe("reviewed");
  });

  it("renders the published V9 mint component instead of a curated recomputation", () => {
    const coin = TRACKED_META_BY_ID.get("steakusdt-steakhouse");
    expect(coin).toBeDefined();

    // 9.1: curated parent metadata no longer changes the mint score — the
    // inheritance blend lived in the retired standalone engine.
    const published = { mint: { score: 70, posture: "partially-bounded-admin" }, caps: [] };
    const withoutRichParent = buildMintAuthorityDetailViewModel(
      buildStablecoinDetailClientCoin(coin!),
      published,
    );
    const withRichParent = buildMintAuthorityDetailViewModel(
      buildStablecoinDetailClientCoin(coin!, { parentById: TRACKED_META_BY_ID }),
      published,
    );

    expect(withoutRichParent.score).toMatchObject({ score: 70, bandLabel: "Governed" });
    expect(withRichParent.score).toEqual(withoutRichParent.score);
  });

  it("projects mint-authority review gaps into the detail view model", () => {
    const viewModel = buildMintAuthorityDetailViewModel(makeMintAuthorityCoin({
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "manual-review",
      summary: "Issuer backend can mint after off-chain approval.",
      sourceFreeRationale: "Issuer API roles were described in docs but no contract source is published.",
      unresolvedQuestions: ["Confirm whether the backend signer can be rotated without governance."],
    }));

    expect(viewModel).toMatchObject({
      status: "reviewed",
      sourceFreeRationale: "Issuer API roles were described in docs but no contract source is published.",
      unresolvedQuestions: ["Confirm whether the backend signer can be rotated without governance."],
    });
  });

  it.each([
    {
      label: "a Safe with a published threshold",
      control: {
        chain: "ethereum",
        address: "0x123400000000000000000000000000000000abcd",
        label: "Issuer Safe",
        role: "minter-admin",
        authorityType: "safe",
        directMintAbility: "can-authorize",
        threshold: 2,
        signerCount: 3,
        modulesOrGuardsStatus: "none-detected",
      },
      expected: {
        locationLabel: "ethereum / 0x123400...00abcd",
        fullLocationLabel: "ethereum / 0x123400000000000000000000000000000000abcd",
        addressUrl: "https://etherscan.io/address/0x123400000000000000000000000000000000abcd",
        securitySetupLabel: "Safe, 2/3 threshold",
        thresholdLabel: "2/3 threshold",
        modulesOrGuardsLabel: "No modules or guards detected",
        custodyLabel: null,
      },
    },
    {
      label: "a single operator key",
      control: {
        chain: "ethereum",
        address: "0x123400000000000000000000000000000000abcd",
        label: "Operator key",
        role: "direct-minter",
        authorityType: "eoa",
        directMintAbility: "direct",
      },
      expected: {
        securitySetupLabel: "Externally owned account",
        custodyLabel: "Single-key address - custody unverifiable",
        modulesOrGuardsLabel: null,
      },
    },
    {
      label: "a role-gated minter contract",
      control: {
        chain: "ethereum",
        address: "0x567800000000000000000000000000000000abcd",
        label: "Minter contract",
        role: "direct-minter",
        authorityType: "contract",
        directMintAbility: "direct",
        modulesOrGuardsStatus: "not-applicable",
      },
      expected: { securitySetupLabel: "Contract", modulesOrGuardsLabel: null, custodyLabel: null },
    },
    {
      label: "an unresolved admin",
      control: {
        chain: "ethereum",
        address: "0x9abc00000000000000000000000000000000abcd",
        label: "Unresolved admin",
        role: "minter-admin",
        authorityType: "unknown",
        directMintAbility: "can-authorize",
        modulesOrGuardsStatus: "unknown",
      },
      expected: { modulesOrGuardsLabel: "Modules or guards unknown", custodyLabel: null },
    },
  ] as ReadonlyArray<{
    label: string;
    control: MintAuthorityClientControlSummary;
    expected: Partial<MintAuthorityDetailControlViewModel>;
  }>)("labels $label", ({ control, expected }) => {
    const viewModel = buildMintAuthorityDetailViewModel(makeControlCoin(control));

    expect(viewModel.controls[0]).toMatchObject(expected);
    // Control rows are curated descriptions; the score and band come from the
    // publication, which these fixtures do not carry.
    expect(viewModel.score).toMatchObject({ score: null, bandLabel: "NR" });
  });

  it("keeps the mint-incident callout on the detail card", () => {
    const coin = TRACKED_META_BY_ID.get("usr-resolv");
    expect(coin).toBeDefined();

    const viewModel = buildMintAuthorityDetailViewModel(buildStablecoinDetailClientCoin(coin!));

    // `reviewedAt` is curated data that moves with every mint-authority research
    // wave (it changed in #869), so pin the pass-through contract, not the value.
    expect(viewModel.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(viewModel.mintIncidents).toHaveLength(1);
    expect(viewModel.mintIncidents[0]).toMatchObject({
      date: "2026-03-22",
      summary: expect.stringContaining("80M unbacked USR"),
      sources: expect.arrayContaining([
        expect.objectContaining({
          label: expect.any(String),
          url: expect.stringContaining("https://"),
        }),
      ]),
    });
  });

  it("sorts incident callouts from a typed mint-authority summary", () => {
    const viewModel = buildMintAuthorityDetailViewModel(makeMintAuthorityCoin({
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "verified",
      summary: "Issuer backend can mint through reviewed operator controls.",
      sources: [
        { label: "Review", url: "https://example.com/review" },
        { label: "Docs", url: "https://example.com/docs" },
      ],
      mintIncidents: [
        {
          date: "2024-01-01",
          status: "resolved",
          summary: "Older privileged mint incident.",
          sources: [{ label: "Postmortem", url: "https://example.com/postmortem" }],
        },
        {
          date: "2025-02-01",
          status: "active",
          summary: "Newer privileged mint incident.",
          sources: [{ label: "Thread", url: "https://example.com/thread" }],
        },
      ],
    }));

    expect(viewModel.sources).toEqual([
      { label: "Review", url: "https://example.com/review" },
      { label: "Docs", url: "https://example.com/docs" },
    ]);
    expect(viewModel.mintIncidents.map((incident) => incident.date)).toEqual(["2025-02-01", "2024-01-01"]);
    expect(viewModel.mintIncidents[1]?.sources).toEqual([
      { label: "Postmortem", url: "https://example.com/postmortem" },
    ]);
  });
});
