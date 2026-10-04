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
import { makePublishedIssuanceSummary, makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import type { V1005ProcessDiagnostic } from "@shared/types/safety-score-v9-facts";

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

describe("published operational-governance detail", () => {
  it("renders an explicitly unbounded neutral H label with the published Governed55 score", () => {
    const coin = makeMintAuthorityCoin({ mintPath: "user-collateralized-governed",
      authorityPosture: "unbounded-operationally-governed", confidence: "verified", summary: "Reviewed operational envelopes." });
    const view = buildMintAuthorityDetailViewModel(coin, {
      mint: { score: 55, posture: "unbounded-operationally-governed" }, caps: [],
    });
    expect(view).toMatchObject({ authorityPostureLabel: "Unbounded, operationally governed",
      authorityPostureTone: "neutral", score: { score: 55, bandLabel: "Governed" }, processEvidenceAvailable: false });
  });

  it("matches normalized control identity rather than labels/index and keeps null/unmatched failures visible at NR", () => {
    const address = `0x${"a".repeat(40)}`;
    const ref = `ethereum:${address}`;
    const missing: V1005ProcessDiagnostic = { code: "runtime-unmatched", gate: "H0", controlRef: ref,
      pathId: "redo", classId: "keeper-class", memberRef: ref, field: "runtimeHash", evidenceRefIds: ["code-read"] };
    const failed: V1005ProcessDiagnostic = { ...missing, code: "operational-screen-failed", gate: "H3",
      controlRef: null, pathId: null, classId: null, memberRef: null, field: "operationalExposurePpm" };
    const orphanRef = `ethereum:0x${"b".repeat(40)}`;
    const unsampledRef = `ethereum:0x${"d".repeat(40)}`;
    const missingGroup = makePublishedProcessDiagnostic(missing, { count: 4, controlRefs: [ref, orphanRef, unsampledRef] });
    const failedGroup = makePublishedProcessDiagnostic(failed);
    const coin = makeMintAuthorityCoin({ mintPath: "user-collateralized-governed", authorityPosture: "unknown",
      confidence: "manual-review", summary: "Incomplete process evidence.", controls: [
        { label: "Same label", role: "direct-minter", authorityType: "contract", directMintAbility: "direct",
          chain: "ethereum", address: `0x${"c".repeat(40)}` },
        { label: "Same label", role: "direct-minter", authorityType: "contract", directMintAbility: "direct",
          chain: "ethereum", address: address.toUpperCase().replace("0X", "0x") },
        { label: "Same label", role: "direct-minter", authorityType: "contract", directMintAbility: "direct",
          chain: "ethereum", address: `0x${"d".repeat(40)}` },
      ] });
    const view = buildMintAuthorityDetailViewModel(coin, { mint: null, caps: [],
      issuanceSummary: makePublishedIssuanceSummary({}, [missingGroup, failedGroup]) });
    expect(view.score?.score).toBeNull();
    expect(view.controls[0]!.processDiagnostics).toEqual([]);
    expect(view.controls[1]!.processDiagnostics).toEqual([expect.objectContaining({ ...missingGroup, statusLabel: "Missing evidence" })]);
    expect(view.controls[2]!.processDiagnostics).toEqual([expect.objectContaining({ ...missingGroup, statusLabel: "Missing evidence" })]);
    expect(view.processMetrics).toContainEqual({ label: "Actual operational exercise delay", value: "0 s" });
    expect(view.processDiagnostics).toEqual([
      expect.objectContaining({ ...missingGroup, statusLabel: "Missing evidence" }),
      expect.objectContaining({ ...failedGroup, statusLabel: "Failed screen" }),
    ]);
    expect(view.processMetrics).toContainEqual({ label: "Discretionary public delay", value: "172800 s" });
    expect(view.processMetrics).toContainEqual({ label: "Max annual interest growth", value: "500000 ppm / year" });
    expect(view.processEvidenceAvailable).toBe(true);
  });

  it("distinguishes proved absence of envelope transitions from a missing public-delay measurement", () => {
    const coin = makeMintAuthorityCoin({ mintPath: "user-collateralized-governed", authorityPosture: "unknown",
      confidence: "manual-review", summary: "Reviewed path inventory." });
    const absent = buildMintAuthorityDetailViewModel(coin, { mint: null, caps: [],
      issuanceSummary: makePublishedIssuanceSummary({ envelopeTransitionPathCount: 0, minEnvelopeRaisePublicDelaySec: null }) });
    expect(absent.processMetrics).toContainEqual({ label: "Envelope-raise public delay", value: "Not applicable (no envelope-transition paths)" });
    const unknown = buildMintAuthorityDetailViewModel(coin, { mint: null, caps: [],
      issuanceSummary: makePublishedIssuanceSummary({ envelopeTransitionPathCount: 1, minEnvelopeRaisePublicDelaySec: null }) });
    expect(unknown.processMetrics).toContainEqual({ label: "Envelope-raise public delay", value: "Unproved" });
    expect(unknown.score?.score).toBeNull();
  });

  it("shows the measured interval as inapplicable only when no recurring path is funded", () => {
    const coin = makeMintAuthorityCoin({ mintPath: "user-collateralized-governed", authorityPosture: "unknown",
      confidence: "manual-review", summary: "Reviewed recurring funding." });
    const summary = makePublishedIssuanceSummary({ fundedKeeperRecurringPathCount: 0,
      minKeeperRecurringIntervalSec: null, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 0,
      keeperSupplyScreenBasis: { nativeSupplyRaw: "1000000", maxFixedRewardRaw: "10",
        maxRepeatRewardRawPer86400Sec: "0", nativeUnits: "native" } });
    const unfunded = buildMintAuthorityDetailViewModel(coin, { mint: null, caps: [], issuanceSummary: summary });
    expect(unfunded.processMetrics).toContainEqual({ label: "Funded recurring keeper paths", value: "0 / 1" });
    expect(unfunded.processMetrics).toContainEqual({ label: "Minimum recurring keeper interval", value: "Not applicable (no funded recurring paths)" });
    const funded = buildMintAuthorityDetailViewModel(coin, { mint: null, caps: [],
      issuanceSummary: makePublishedIssuanceSummary({ minKeeperRecurringIntervalSec: null }) });
    expect(funded.processMetrics).toContainEqual({ label: "Minimum recurring keeper interval", value: "Unproved" });
    expect(funded.score?.score).toBeNull();
  });
});
