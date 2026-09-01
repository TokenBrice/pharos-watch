import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { parseStablecoinMetaAssets } from "@shared/lib/stablecoins/schema";
import fusdRiskReview from "@shared/data/stablecoins/domains/risk-review/fusd-finchain.json";
import type {
  BridgeRouteControl,
  BridgeRouteDeployment,
  BridgeRouteRiskProfile,
  MintAuthorityControl,
  MintAuthorityProfile,
} from "@shared/types/core";
import { v9RepresentationGroupRouteKey } from "@shared/lib/safety-score-v9/facts";
import { describe, expect, it } from "vitest";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9-fact-set";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import {
  adaptBridgeReview,
  mergedBridgeAuthority,
  mergedBridgeCapSemantics,
  type StructuredBridgeOverlayEntry,
} from "../safety-score-v9-extension-bridge";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import {
  ReviewEvidenceBuilder,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension-shared";
import {
  makeV9FixedInput,
  v9TestClockSec,
} from "../../test-helpers/v9-fixed-input";

const SOURCE = { label: "Fixture review", url: "https://example.com/review" };
const ARBITRUM_ROUTE = "arbitrum:0x2222222222222222222222222222222222222222";
const BASE_ROUTE = "base:0x3333333333333333333333333333333333333333";
const ETHEREUM_ROUTE = "ethereum:0x1111111111111111111111111111111111111111";

function route(
  id: string,
  overrides: Partial<BridgeRouteDeployment> = {},
): BridgeRouteDeployment {
  const separator = id.indexOf(":");
  const chain = id.slice(0, separator);
  return {
    id,
    destinationChain: chain,
    contractAddress: id.slice(separator + 1),
    protocol: "Fixture transfer rail",
    issuanceModel: "native-issuance",
    routeClass: "native",
    riskTier: "single-chain-or-native",
    semantics: "native-mint",
    scope: "canonical",
    reviewDisposition: "reviewed",
    observedAt: "1970-01-01",
    sources: [SOURCE],
    ...overrides,
  };
}

function representationRoute(
  id: string,
  overrides: Partial<BridgeRouteDeployment> = {},
): BridgeRouteDeployment {
  return route(id, {
    sourceChain: "arbitrum",
    canonicalChain: "arbitrum",
    protocol: "Fixture representation",
    issuanceModel: "bridge-representation",
    routeClass: "third-party",
    riskTier: "external-lock-mint",
    semantics: "lock-mint",
    scope: "peripheral",
    ...overrides,
  });
}

function mintControl(
  overrides: Partial<MintAuthorityControl> = {},
): MintAuthorityControl {
  return {
    chain: "arbitrum",
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: "Fixture native minter",
    role: "direct-minter",
    authorityType: "contract",
    directMintAbility: "direct",
    sources: [SOURCE],
    ...overrides,
  };
}

function mintProfile(
  overrides: Partial<MintAuthorityProfile> = {},
): MintAuthorityProfile {
  return {
    mintPath: "issuer-direct-mint",
    authorityPosture: "partially-bounded-admin",
    confidence: "verified",
    summary: "The fixture has a reviewed native issuance authority.",
    controls: [mintControl()],
    review: {
      sources: [SOURCE],
      evidence: "The fixture review identifies the native issuance authority.",
      reviewer: "Fixture reviewer",
      reviewedAt: "1970-01-01",
    },
    ...overrides,
  };
}

function bridgeControl(
  overrides: Partial<BridgeRouteControl> = {},
): BridgeRouteControl {
  return {
    id: "fixture-bridge-control",
    label: "Fixture structured bridge controller",
    routeRefs: [BASE_ROUTE],
    capabilities: ["bridge-mint"],
    controllerChain: "base",
    controllerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    authorityType: "contract",
    sources: [SOURCE],
    ...overrides,
  };
}

function bridgeProfile(
  routes: BridgeRouteDeployment[],
  overrides: Partial<BridgeRouteRiskProfile> = {},
): BridgeRouteRiskProfile {
  return {
    tier: "issuer-native-burn-mint",
    summary: "The fixture has reviewed native and transfer-rail deployments.",
    reviewedAt: "1970-01-01",
    reviewer: "Fixture reviewer",
    confidence: "verified",
    sources: [SOURCE],
    routes,
    ...overrides,
  };
}

function meta(
  id: string,
  overrides: Partial<V9ExtensionRegistryMeta> = {},
): V9ExtensionRegistryMeta {
  return {
    id,
    mechanismArchetype: "fiat-cash",
    ...overrides,
  };
}

function supplyByRoute(routes: readonly BridgeRouteDeployment[]) {
  return Object.fromEntries(
    [...new Set(routes.map((candidate) => candidate.destinationChain))].map((chain) => [
      chain,
      {
        current: 10_000_000,
        circulatingPrevDay: 10_000_000,
        circulatingPrevWeek: 10_000_000,
        circulatingPrevMonth: 10_000_000,
      },
    ]),
  );
}

function compileFixture(
  metadata: V9ExtensionRegistryMeta,
  options: { clockSec?: number; chainSupplyByChain?: ReturnType<typeof supplyByRoute> } = {},
) {
  const routes = metadata.bridgeRouteRisk?.routes ?? [];
  const clockSec = options.clockSec ?? 10_000;
  const fixed = makeV9FixedInput({
    assetId: metadata.id,
    clockSec,
    chainSupplyByChain: options.chainSupplyByChain ?? supplyByRoute(routes),
  });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([[metadata.id, metadata]]),
  });
  const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(
    normalizeFixedInput(fixed),
    extension,
  );
  return { extension, compiled };
}

function controlsFor(
  compiled: ReturnType<typeof compileFixture>["compiled"],
  assetId: string,
) {
  return compiled.assets[0]!.controls.filter((control) =>
    control.controlKey.startsWith(`mint-meta:${assetId}:`) ||
    control.controlKey.startsWith(`bridge-meta:${assetId}:`),
  );
}

function representationSupplyReview(
  assetId: string,
  representationId: string,
): NonNullable<Parameters<typeof adaptBridgeReview>[1]> {
  return {
    selectedBridgeRoutes: [
      {
        deploymentRouteKey: v9RepresentationGroupRouteKey(assetId, representationId),
        supplyUsd: 10_000_000,
        supplyShare: 1,
        reviewState: "selected-reviewed",
        reviewedRouteKind: "controlled",
      },
    ],
    selectedRouteSupplyShare: 1,
    unknownRouteSupplyShare: 0,
    unreviewedRouteSupplyShare: 0,
    failureDomains: [],
  };
}

function adaptBridgeFixture(
  metadata: V9ExtensionRegistryMeta,
  supplyReview: NonNullable<Parameters<typeof adaptBridgeReview>[1]> | null,
  chainRows?: Readonly<Record<string, { current: number }>>,
  clockSec = 10_000,
) {
  return adaptBridgeReview(
    metadata,
    supplyReview,
    2,
    new ReviewEvidenceBuilder(metadata.id, clockSec),
    clockSec,
    chainRows,
  );
}

/**
 * Minimal structured-overlay entry for the merge helpers. Only the fields those
 * helpers read are populated; everything else stays absent so a future field cannot
 * be silently satisfied by a fixture default.
 */
function overlayEntry(
  controlId: string,
  capSemantics: StructuredBridgeOverlayEntry["overlay"]["capSemantics"],
): StructuredBridgeOverlayEntry {
  return {
    sourceControl: bridgeControl({ id: controlId, routeRefs: [BASE_ROUTE] }),
    overlay: { capSemantics } as StructuredBridgeOverlayEntry["overlay"],
  };
}

describe("Safety Score v9 Mint Authority / Bridge Risk scope", () => {
  it("rejects a raw active Mint Authority bridge capability at both enforcement layers", () => {
    const contaminatedMeta = {
      ...meta("fixture-contaminated-mint-bridge", {
        status: "active",
        mintAuthority: mintProfile({
          controls: [
            mintControl({
              role: "bridge-admin",
              directMintAbility: "none",
              deploymentRefs: [ARBITRUM_ROUTE],
            }),
          ],
        }),
        bridgeRouteRisk: bridgeProfile([route(ARBITRUM_ROUTE)]),
        contracts: [
          {
            chain: "arbitrum",
            address: ARBITRUM_ROUTE.slice(ARBITRUM_ROUTE.indexOf(":") + 1),
            decimals: 18,
          },
        ],
      }),
      name: "Fixture Contaminated",
      symbol: "FC",
      flags: {
        pegCurrency: "USD" as const,
        governance: "centralized" as const,
        backing: "rwa-backed" as const,
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
    };

    expect(() => parseStablecoinMetaAssets([contaminatedMeta], "contaminated fixture")).toThrow(
      "[mint-bridge-ownership:bridge-capability-in-mint]",
    );
    expect(() => compileFixture(contaminatedMeta)).toThrow(/bridge-capability-in-mint/);
  });

  it.each(["usdai-usd-ai", "susdai-usd-ai"])(
    "%s compiles Arbitrum mint controls separately from satellite bridge controls",
    (assetId) => {
      const metadata = ACTIVE_META_BY_ID.get(assetId);
      if (!metadata?.mintAuthority || !metadata.bridgeRouteRisk?.routes) {
        throw new Error(`expected boundary metadata for ${assetId}`);
      }
      const clockSec = v9TestClockSec();
      const { compiled } = compileFixture(metadata, { clockSec });
      const asset = compiled.assets[0]!;
      const mintControls = asset.controls.filter((control) =>
        control.controlKey.startsWith(`mint-meta:${assetId}:`),
      );
      const bridgeControls = asset.controls.filter((control) =>
        control.controlKey.startsWith(`bridge-meta:${assetId}:`),
      );
      const satelliteRoutes = metadata.bridgeRouteRisk.routes.filter(
        (route) => route.issuanceModel !== "native-issuance",
      );
      const nativeDeploymentKeys = new Set(
        metadata.bridgeRouteRisk.routes
          .filter((route) => route.issuanceModel === "native-issuance")
          .map((route) => route.id),
      );
      const satelliteAuthorityKeys = satelliteRoutes.map(
        (route) => `${route.controllerChain}:${route.controllerAddress!.toLowerCase()}`,
      );

      expect(mintControls).toHaveLength(metadata.mintAuthority.controls?.length ?? 0);
      expect(
        mintControls.every(
          (control) =>
            control.deploymentKey === `asset:${assetId}` || nativeDeploymentKeys.has(control.deploymentKey),
        ),
      ).toBe(true);
      expect(mintControls.every((control) => !satelliteAuthorityKeys.includes(control.authority?.authorityKey ?? ""))).toBe(
        true,
      );
      expect(bridgeControls.map((control) => control.deploymentKey).sort()).toEqual(
        satelliteRoutes.map((route) => route.id).sort(),
      );
      expect(bridgeControls.every((control) => control.capabilities.includes("bridge-mint"))).toBe(true);
      expect(bridgeControls.map((control) => control.authority?.authorityKey).sort()).toEqual(
        satelliteAuthorityKeys.sort(),
      );
    },
  );

  it("emits a deployment-bound authority with its real key, non-root reach, and reconciled share", () => {
    const routes = [route(ARBITRUM_ROUTE), route(BASE_ROUTE)];
    const metadata = meta("fixture-issuer-native", {
      mintAuthority: mintProfile({
        controls: [mintControl({ deploymentRefs: [ARBITRUM_ROUTE] })],
      }),
      bridgeRouteRisk: bridgeProfile(routes, {
        controls: [
          bridgeControl({
            id: "issuer-native-transfer-pool",
            routeRefs: [BASE_ROUTE],
            capabilities: ["bridge-burn", "bridge-mint", "rate-limit", "peer-config"],
          }),
        ],
      }),
    });
    const { compiled } = compileFixture(metadata);
    const controls = controlsFor(compiled, metadata.id);
    const mint = controls.find((control) => control.controlKey.startsWith("mint-meta:"));
    const bridge = controls.find((control) => control.controlKey.startsWith("bridge-meta:"));

    expect(mint).toMatchObject({
      deploymentKey: ARBITRUM_ROUTE,
      scope: "deployment",
      economicLossScope: "deployment",
      materialSupplyShare: 0.5,
      capabilities: ["mint"],
    });
    expect(bridge).toMatchObject({
      deploymentKey: BASE_ROUTE,
      capabilities: ["bridge-mint", "burn", "parameter-change"],
    });
    expect(controls).toHaveLength(2);
    expect(bridge!.capabilities).not.toContain("mint");
  });

  it("keeps a deployment-bound authority global when the supply partition does not reconcile", () => {
    const routes = [route(ARBITRUM_ROUTE), route(BASE_ROUTE)];
    const metadata = meta("fixture-unreconciled-native-control", {
      mintAuthority: mintProfile({
        controls: [mintControl({ deploymentRefs: [ARBITRUM_ROUTE] })],
      }),
      bridgeRouteRisk: bridgeProfile(routes),
    });
    const { compiled } = compileFixture(metadata, {
      chainSupplyByChain: {
        ...supplyByRoute(routes),
        optimism: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    });
    const mint = controlsFor(compiled, metadata.id).find((control) =>
      control.controlKey.startsWith("mint-meta:"),
    );

    expect(mint).toMatchObject({
      deploymentKey: `asset:${metadata.id}`,
      scope: "global",
      economicLossScope: "global-claim",
      materialSupplyShare: null,
    });
  });

  it("keeps an authority reaching every reconciled deployment global", () => {
    const routes = [route(ARBITRUM_ROUTE), route(BASE_ROUTE)];
    const metadata = meta("fixture-root-reaching-native-control", {
      mintAuthority: mintProfile({
        controls: [mintControl({ deploymentRefs: [ARBITRUM_ROUTE, BASE_ROUTE] })],
      }),
      bridgeRouteRisk: bridgeProfile(routes),
    });
    const { compiled } = compileFixture(metadata);
    const mint = controlsFor(compiled, metadata.id).find((control) =>
      control.controlKey.startsWith("mint-meta:"),
    );

    expect(mint).toMatchObject({
      deploymentKey: `asset:${metadata.id}`,
      scope: "global",
      economicLossScope: "global-claim",
      materialSupplyShare: null,
    });
  });


  it("scopes the USDP Token-2022 upgrade authority to its 5.81% Solana deployment", () => {
    const metadata = ACTIVE_META_BY_ID.get("usdp-paxos");
    if (!metadata?.bridgeRouteRisk?.routes) throw new Error("expected reviewed USDP route metadata");
    const chainSupplyByChain = Object.fromEntries(
      metadata.bridgeRouteRisk.routes.map((candidate) => [
        candidate.destinationChain,
        {
          current:
            candidate.destinationChain === "solana"
              ? 5_810_000
              : candidate.destinationChain === "ethereum"
                ? 94_190_000
                : 0,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        },
      ]),
    );
    const { compiled } = compileFixture(metadata, {
      clockSec: v9TestClockSec(),
      chainSupplyByChain,
    });
    const token2022Upgrade = compiled.assets[0]!.controls.find((control) =>
      control.failureDomains.some(
        (domain) => domain.key === "platform:solana-token-2022-program",
      ),
    );

    expect(token2022Upgrade).toMatchObject({
      deploymentKey: "solana:HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM",
      scope: "deployment",
      economicLossScope: "deployment",
      materialSupplyShare: 0.0581,
    });
  });

  it("fails closed on disagreement between structured bridge cap bounds while matching bounds stay bounded", () => {
    const metadata = meta("fixture-matching-bridge-caps", {
      bridgeRouteRisk: bridgeProfile([representationRoute(BASE_ROUTE)], {
        controls: [
          bridgeControl({
            id: "bounded-bridge-cap-a",
            routeRefs: [BASE_ROUTE],
            canRaiseCap: false,
          }),
          bridgeControl({
            id: "bounded-bridge-cap-b",
            routeRefs: [BASE_ROUTE],
            canRaiseCap: false,
          }),
        ],
      }),
    });
    const matchingBridge = controlsFor(compileFixture(metadata).compiled, metadata.id).find((control) =>
      control.controlKey.startsWith(`bridge-meta:${metadata.id}:`),
    );

    expect(matchingBridge).toMatchObject({
      capSemantics: { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } },
    });

    // Every authored control currently compiles the same bounded shape, so the
    // disagreement guard is unreachable through fixtures. Drive the merge directly
    // rather than mutating global state: a route whose covering controls disagree on
    // the bound must lose the bound entirely instead of adopting either side's.
    expect(
      mergedBridgeCapSemantics([
        overlayEntry("bounded-bridge-cap-a", { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } }),
        overlayEntry("bounded-bridge-cap-b", { kind: "bounded", bound: { amount: 2, unit: "supply-fraction" } }),
      ]),
    ).toEqual({ kind: "unbounded", bound: null });

    expect(
      mergedBridgeCapSemantics([
        overlayEntry("bounded-bridge-cap-a", { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } }),
        overlayEntry("bounded-bridge-cap-b", { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } }),
      ]),
    ).toEqual({ kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } });
  });

  it("retains intrinsic bridge-mint for a reviewed representation route without structured coverage", () => {
    const metadata = meta("fixture-intrinsic-bridge-mint", {
      bridgeRouteRisk: bridgeProfile([representationRoute(BASE_ROUTE)]),
    });
    const { compiled } = compileFixture(metadata);
    const bridge = controlsFor(compiled, metadata.id).find((control) =>
      control.controlKey.startsWith(`bridge-meta:${metadata.id}:`),
    );

    expect(bridge).toMatchObject({
      deploymentKey: BASE_ROUTE,
      capabilities: ["bridge-mint"],
    });
  });

  it("fails the V9 producer with route and control attribution for shadowed representation bridge-mint", () => {
    const metadata = meta("fixture-shadowed-bridge-mint", {
      bridgeRouteRisk: bridgeProfile([representationRoute(BASE_ROUTE)], {
        controls: [
          bridgeControl({
            id: "admin-only-shadow",
            routeRefs: [BASE_ROUTE],
            capabilities: ["admin"],
          }),
        ],
      }),
    });

    expect(() => compileFixture(metadata)).toThrow(
      `Safety Score v9 mint/bridge ownership validation failed for fixture-shadowed-bridge-mint: representation-route-without-bridge-mint at bridgeRouteRisk.routes[0].id: reviewed representation route "${BASE_ROUTE}" is covered by control IDs ["admin-only-shadow"], but none includes "bridge-mint"; name the bridge-mint holder in one of those controls, or stop referencing the route so the conservative route-derived fallback overlay applies`,
    );
  });

  it("rejects a structured bridge control that references an unknown route", () => {
    const unknownRoute = "base:0x4444444444444444444444444444444444444444";
    const metadata = meta("fixture-unknown-bridge-route", {
      bridgeRouteRisk: bridgeProfile([representationRoute(BASE_ROUTE)], {
        controls: [
          bridgeControl({
            id: "unknown-route-control",
            routeRefs: [unknownRoute],
          }),
        ],
      }),
    });

    expect(() => adaptBridgeFixture(metadata, null)).toThrow(
      `Safety Score v9 bridge control unknown-route-control for fixture-unknown-bridge-route references unknown route ${unknownRoute}`,
    );
  });

  it("synthesizes an unknown bridge authority when covering overlays have no authority", () => {
    // `bridgeAuthority()` always yields an authority for an authored control, so the
    // unattributed fallback is only reachable by driving the merge directly. It must
    // synthesize an explicitly unknown authority keyed to the route, so a bridge
    // control with no attributable controller never reads as a safe one.
    expect(mergedBridgeAuthority([], BASE_ROUTE)).toEqual({
      authorityKey: `bridge-route:${BASE_ROUTE}`,
      model: "unknown",
      threshold: null,
    });
  });

  it("compiles a representation group only when every member is reviewed wrapped lock-mint", () => {
    const representationId = "fixture-wrapped-representation";
    const acceptingRoute = representationRoute(BASE_ROUTE, {
      representationId,
      issuanceModel: "wrapped-representation",
    });
    const acceptingMetadata = meta("fixture-accepted-representation-group", {
      bridgeRouteRisk: bridgeProfile([acceptingRoute]),
    });
    const groupRouteKey = v9RepresentationGroupRouteKey(acceptingMetadata.id, representationId);
    const accepting = adaptBridgeFixture(
      acceptingMetadata,
      representationSupplyReview(acceptingMetadata.id, representationId),
    );

    expect(accepting.controls).toContainEqual(
      expect.objectContaining({
        controlKey: expect.stringMatching(/^bridge-group:/),
        deploymentKey: groupRouteKey,
        capabilities: ["bridge-mint"],
      }),
    );

    const rejectingMetadata = meta("fixture-rejected-representation-group", {
      bridgeRouteRisk: bridgeProfile([
        representationRoute(BASE_ROUTE, {
          representationId,
          issuanceModel: "wrapped-representation",
          reviewDisposition: "unresolved",
        }),
      ]),
    });
    const rejecting = adaptBridgeFixture(
      rejectingMetadata,
      representationSupplyReview(rejectingMetadata.id, representationId),
    );

    expect(rejecting.controls.some((control) => control.controlKey.startsWith("bridge-group:"))).toBe(false);
    expect(rejecting.controls).toContainEqual(
      expect.objectContaining({ deploymentKey: BASE_ROUTE, controlKind: "bridge" }),
    );
  });

  it("keeps a shared Safe identity-linked while separating native mint from bridge capabilities", () => {
    const sharedAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
    const metadata = meta("fixture-shared-safe", {
      mintAuthority: mintProfile({
        controls: [
          mintControl({
            address: sharedAddress,
            authorityType: "safe",
            directMintAbility: "cap-limited",
            deploymentRefs: [ARBITRUM_ROUTE],
            threshold: 2,
            signerCount: 3,
          }),
        ],
      }),
      bridgeRouteRisk: bridgeProfile([route(ARBITRUM_ROUTE)], {
        controls: [
          bridgeControl({
            id: "shared-safe-transfer-rail",
            routeRefs: [ARBITRUM_ROUTE],
            controllerChain: "arbitrum",
            controllerAddress: sharedAddress,
            authorityType: "safe",
            threshold: 2,
            signerCount: 3,
            capabilities: ["bridge-mint", "peer-config"],
          }),
        ],
      }),
    });
    const { compiled } = compileFixture(metadata);
    const controls = controlsFor(compiled, metadata.id);
    const mint = controls.find((control) => control.controlKey.startsWith("mint-meta:"))!;
    const bridge = controls.find((control) => control.controlKey.startsWith("bridge-meta:"))!;

    expect(mint.authority).toMatchObject({
      authorityKey: `arbitrum:${sharedAddress}`,
      model: "multisig",
      threshold: { required: 2, total: 3 },
    });
    expect(bridge.authority).toEqual(mint.authority);
    expect(mint.capabilities).toEqual(["mint"]);
    expect(bridge.capabilities).toContain("bridge-mint");
    expect(mint.controlKey).not.toBe(bridge.controlKey);
  });

  it("compiles a reviewed inherited wrapper with no local issuance fail-closed", () => {
    const routes = [representationRoute(ETHEREUM_ROUTE), representationRoute(BASE_ROUTE)];
    const metadata = meta("fixture-inherited-wrapper", {
      mintAuthority: mintProfile({
        mintPath: "wrapped-or-variant-inherited",
        inheritedFrom: "parent-fixture",
        controls: [],
        review: {
          sources: [SOURCE],
          evidence: "The wrapper has no local canonical issuance and inherits issuance from its reviewed parent asset.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
          noLocalIssuance: {
            kind: "inherited-parent-issuance",
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            rationale: "The wrapper creates no local canonical liabilities; issuance is inherited from the parent.",
            sources: [SOURCE],
          },
        },
      }),
      bridgeRouteRisk: bridgeProfile(routes),
    });
    const { compiled } = compileFixture(metadata);
    const asset = compiled.assets[0]!;

    expect(asset.economicControlReview.mint).toMatchObject({
      status: { observationState: "bounded-unknown" },
      controlKey: null,
    });
    expect(asset.controls.filter((control) => control.capabilities.includes("bridge-mint"))).not.toHaveLength(0);
  });

  it.each([
    {
      label: "missing structured controls",
      controls: undefined,
      reviewedAt: "1970-01-01",
      clockSec: 10_000,
    },
    {
      label: "stale structured controls",
      controls: [
        bridgeControl({ observedAt: "2020-01-01" }),
      ],
      reviewedAt: "2020-01-01",
      clockSec: Date.parse("2026-08-17T00:00:00.000Z") / 1_000,
    },
  ])("keeps a conservative route-derived bridge control when bridge facts are $label", ({ controls, reviewedAt, clockSec }) => {
    const bridgeRoute = representationRoute(BASE_ROUTE);
    const metadata = meta(`fixture-bridge-fallback-${reviewedAt}`, {
      bridgeRouteRisk: bridgeProfile([bridgeRoute], { controls, reviewedAt }),
    });
    const { compiled } = compileFixture(metadata, { clockSec });
    const asset = compiled.assets[0]!;
    const bridge = asset.controls.find((control) =>
      control.controlKey.startsWith(`bridge-meta:${metadata.id}:`),
    );

    expect(bridge).toMatchObject({
      deploymentKey: BASE_ROUTE,
      capabilities: ["bridge-mint"],
    });
    expect(asset.economicControlReview.bridge.status.observationState).toBe(
      controls === undefined ? "known" : "bounded-unknown",
    );
    if (controls !== undefined) {
      expect(bridge).toMatchObject({
        capSemantics: { kind: "unknown" },
        claimImpairment: "unknown",
        incidentState: "unknown",
      });
    }
  });

  it.each([
    ["id", "fixture-bridge-control"],
    ["label", "Fixture structured bridge controller"],
    ["controllerChain:controllerAddress", "base:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  ])("marks a bridge control named by a fresh scoped question via its %s", (_kind, controlRef) => {
    const metadata = meta("fixture-bridge-scoped-question", {
      bridgeRouteRisk: bridgeProfile([route(ARBITRUM_ROUTE), representationRoute(BASE_ROUTE)], {
        controls: [
          bridgeControl({
            authorityType: "unknown",
          }),
        ],
        scopedQuestions: [
          {
            controlRef,
            question: "Which entity operates the fixture bridge controller?",
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            sources: [SOURCE],
          },
        ],
      }),
    });
    const { compiled } = compileFixture(metadata);
    const asset = compiled.assets[0]!;
    const unresolved = asset.controls.filter(
      (control) =>
        control.controlKey.startsWith("bridge-meta:fixture-bridge-scoped-question:") &&
        control.status.observationState !== "known",
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.scopedQuestionFresh).toBe(true);
    const controlGap = asset.gaps.find((gap) => gap.gapId === unresolved[0]!.status.gapIds[0]);
    expect(controlGap?.reasonCode).toBe("scoped-control-question");
  });

  it("drops the bridge scoped-question marker once the question ages past the freshness window", () => {
    const metadata = meta("fixture-bridge-scoped-question-stale", {
      bridgeRouteRisk: bridgeProfile([route(ARBITRUM_ROUTE), representationRoute(BASE_ROUTE)], {
        controls: [
          bridgeControl({
            authorityType: "unknown",
          }),
        ],
        scopedQuestions: [
          {
            controlRef: "fixture-bridge-control",
            question: "Which entity operates the fixture bridge controller?",
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            sources: [SOURCE],
          },
        ],
      }),
    });
    const { compiled } = compileFixture(metadata, { clockSec: 91 * 86_400 });
    const asset = compiled.assets[0]!;
    const unresolved = asset.controls.filter(
      (control) =>
        control.controlKey.startsWith("bridge-meta:fixture-bridge-scoped-question-stale:") &&
        control.status.observationState !== "known",
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.scopedQuestionFresh).not.toBe(true);
    const controlGap = asset.gaps.find((gap) => gap.gapId === unresolved[0]!.status.gapIds[0]);
    expect(controlGap?.reasonCode).toBe("unresolved-control-identity");
  });

  it("keeps a route's merged bridge overlay hard when an unresolved sibling control lacks a scoped question", () => {
    const metadata = meta("fixture-bridge-scoped-question-mixed", {
      bridgeRouteRisk: bridgeProfile([route(ARBITRUM_ROUTE), representationRoute(BASE_ROUTE)], {
        controls: [
          bridgeControl({
            authorityType: "unknown",
          }),
          bridgeControl({
            id: "fixture-bridge-control-sibling",
            label: "Fixture sibling bridge controller",
            authorityType: "unknown",
            controllerAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
          }),
        ],
        scopedQuestions: [
          {
            controlRef: "fixture-bridge-control",
            question: "Which entity operates the fixture bridge controller?",
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            sources: [SOURCE],
          },
        ],
      }),
    });
    const { compiled } = compileFixture(metadata);
    const asset = compiled.assets[0]!;
    const unresolved = asset.controls.filter(
      (control) =>
        control.controlKey.startsWith("bridge-meta:fixture-bridge-scoped-question-mixed:") &&
        control.status.observationState !== "known",
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.scopedQuestionFresh).not.toBe(true);
  });

  it("marks a control named by a fresh scoped question and routes its gaps to scoped-control-question", () => {
    const scopedAddress = "mintauthority1solana";
    const metadata = meta("fixture-scoped-question", {
      mintAuthority: mintProfile({
        controls: [
          mintControl(),
          mintControl({
            chain: "solana",
            address: scopedAddress,
            label: "Fixture Solana token authority",
            authorityType: "unknown",
          }),
        ],
        review: {
          sources: [SOURCE],
          evidence: "The fixture review identifies the native issuance authority on two chains.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
          scopedQuestions: [
            {
              controlRef: `solana:${scopedAddress}`,
              question: "Which entity controls the Solana token mint authority?",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              sources: [SOURCE],
            },
          ],
        },
      }),
    });
    const { compiled } = compileFixture(metadata);
    const asset = compiled.assets[0]!;
    const unresolved = asset.controls.filter(
      (control) =>
        control.controlKey.startsWith("mint-meta:fixture-scoped-question:") &&
        control.status.observationState !== "known",
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.scopedQuestionFresh).toBe(true);
    const controlGap = asset.gaps.find((gap) => gap.gapId === unresolved[0]!.status.gapIds[0]);
    expect(controlGap?.reasonCode).toBe("scoped-control-question");
    const inventoryGap = asset.gaps.find((gap) => gap.gapId.endsWith(":gap:deployment-controls"));
    expect(inventoryGap?.reasonCode).toBe("scoped-control-question");
  });

  it("matches a scoped question to a non-addressable control by its label", () => {
    const metadata = meta("fixture-scoped-question-label", {
      mintAuthority: mintProfile({
        controls: [
          mintControl(),
          mintControl({
            chain: "hedera",
            address: undefined,
            label: "Fixture Hedera supply key",
            authorityType: "unknown",
            evidence: "The Hedera supply key is a 2-of-5 multisig whose member attribution is unresolved.",
          }),
        ],
        review: {
          sources: [SOURCE],
          evidence: "The fixture review identifies the native issuance authority on two chains.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
          scopedQuestions: [
            {
              controlRef: "Fixture Hedera supply key",
              question: "Which entities hold the Hedera supply key shares?",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              sources: [SOURCE],
            },
          ],
        },
      }),
    });
    const { compiled } = compileFixture(metadata);
    const asset = compiled.assets[0]!;
    const unresolved = asset.controls.filter(
      (control) =>
        control.controlKey.startsWith("mint-meta:fixture-scoped-question-label:") &&
        control.status.observationState !== "known",
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.scopedQuestionFresh).toBe(true);
  });

  it("drops the scoped-question marker once the question ages past the freshness window", () => {
    const scopedAddress = "mintauthority1solana";
    const metadata = meta("fixture-scoped-question-stale", {
      mintAuthority: mintProfile({
        controls: [
          mintControl(),
          mintControl({
            chain: "solana",
            address: scopedAddress,
            label: "Fixture Solana token authority",
            authorityType: "unknown",
          }),
        ],
        review: {
          sources: [SOURCE],
          evidence: "The fixture review identifies the native issuance authority on two chains.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
          scopedQuestions: [
            {
              controlRef: `solana:${scopedAddress}`,
              question: "Which entity controls the Solana token mint authority?",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              sources: [SOURCE],
            },
          ],
        },
      }),
    });
    const { compiled } = compileFixture(metadata, { clockSec: 91 * 86_400 });
    const asset = compiled.assets[0]!;
    const unresolved = asset.controls.filter(
      (control) =>
        control.controlKey.startsWith("mint-meta:fixture-scoped-question-stale:") &&
        control.status.observationState !== "known",
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.scopedQuestionFresh).not.toBe(true);
    const controlGap = asset.gaps.find((gap) => gap.gapId === unresolved[0]!.status.gapIds[0]);
    expect(controlGap?.reasonCode).toBe("unresolved-control-identity");
    const inventoryGap = asset.gaps.find((gap) => gap.gapId.endsWith(":gap:deployment-controls"));
    expect(inventoryGap?.reasonCode).toBe("unresolved-control-identity");
  });

  it("keeps compiled control keys stable when Mint Authority and bridge controls are reordered", () => {
    const routes = [route(ARBITRUM_ROUTE), representationRoute(BASE_ROUTE)];
    const metadata = meta("fixture-control-order", {
      mintAuthority: mintProfile({
        controls: [
          mintControl({
            label: "First native minter",
            address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            deploymentRefs: [ARBITRUM_ROUTE],
          }),
          mintControl({
            label: "Native upgrade admin",
            address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            role: "proxy-admin",
            directMintAbility: "upgrade-only",
            deploymentRefs: [ARBITRUM_ROUTE],
          }),
        ],
      }),
      bridgeRouteRisk: bridgeProfile(routes, {
        controls: [
          bridgeControl({
            id: "first-bridge-control",
            routeRefs: [BASE_ROUTE],
          }),
          bridgeControl({
            id: "second-bridge-control",
            routeRefs: [ARBITRUM_ROUTE],
            controllerChain: "arbitrum",
            controllerAddress: "0xffffffffffffffffffffffffffffffffffffffff",
            capabilities: ["pause"],
          }),
        ],
      }),
    });
    const { compiled: original } = compileFixture(metadata);
    const reordered = structuredClone(metadata);
    reordered.mintAuthority!.controls!.reverse();
    reordered.bridgeRouteRisk!.controls!.reverse();
    const { compiled: reversed } = compileFixture(reordered);

    expect(
      original.assets[0]!.controls.map((control) => control.controlKey),
    ).toEqual(reversed.assets[0]!.controls.map((control) => control.controlKey));
  });

  it("treats an all-native reviewed inventory with structured controls as no bridge exposure", () => {
    const nativeRoutes = [route(ETHEREUM_ROUTE), route(BASE_ROUTE)];
    const nativeOnly = meta("fixture-all-native-with-controls", {
      status: "active",
      contracts: nativeRoutes.map((candidate) => ({
        chain: candidate.destinationChain,
        address: candidate.contractAddress,
        decimals: 18,
      })),
      bridgeRouteRisk: bridgeProfile(nativeRoutes, {
        controls: [
          bridgeControl({
            id: "fixture-canonical-adapter",
            routeRefs: [BASE_ROUTE],
            capabilities: ["bridge-mint"],
          }),
        ],
      }),
    });

    const adapted = adaptBridgeFixture(nativeOnly, null);

    expect(adapted.review.status.applicability.state).toBe("not-applicable");
    expect(adapted.review.routes).toEqual([]);
    // The relocated control facts must survive in the umbrella inventory.
    expect(adapted.controls.length).toBeGreaterThan(0);
  });

  it("records the native-only bridge join decision for FUSD's four reviewed routes", () => {
    const profile = fusdRiskReview.bridgeRouteRisk as BridgeRouteRiskProfile;
    const routes = profile.routes ?? [];
    expect(routes).toHaveLength(4);
    const supplyReview: NonNullable<Parameters<typeof adaptBridgeReview>[1]> = {
      selectedBridgeRoutes: routes.map((candidate) => ({
        deploymentRouteKey: candidate.id,
        supplyUsd: 1,
        supplyShare: 1 / routes.length,
        reviewState: "selected-reviewed",
        reviewedRouteKind: "native",
      })),
      selectedRouteSupplyShare: 1,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [],
    };
    const chainRows = Object.fromEntries(
      routes.map((candidate) => [candidate.destinationChain, { current: 1 }]),
    );
    const adapted = adaptBridgeFixture(
      meta("fusd-finchain", { bridgeRouteRisk: profile }),
      supplyReview,
      chainRows,
      v9TestClockSec(),
    );

    expect(adapted.review.status.applicability.state).toBe("not-applicable");
    expect(adapted.review.diagnostics).toEqual({
      profileRouteCount: 4,
      canonicalSupplyRowCount: 4,
      unmatchedRowIdentities: [],
      reviewedNativeCoverage: {
        reviewedRowCount: 4,
        canonicalSupplyRowCount: 4,
        supplyShare: 1,
        complete: true,
      },
      bridgeClaimControls: [],
      applicabilityBranch: "native-only-not-applicable",
      // The not-applicable branch never reaches the sub-threshold join proof.
      unprovenRouteJoins: [],
    });
  });

  it("keeps the FUSD join applicable and names an unmatched raw chain label", () => {
    const profile = fusdRiskReview.bridgeRouteRisk as BridgeRouteRiskProfile;
    const routes = profile.routes ?? [];
    const supplyReview: NonNullable<Parameters<typeof adaptBridgeReview>[1]> = {
      selectedBridgeRoutes: [
        ...routes.map((candidate) => ({
          deploymentRouteKey: candidate.id,
          supplyUsd: 1,
          supplyShare: 0.2,
          reviewState: "selected-reviewed" as const,
          reviewedRouteKind: "native" as const,
        })),
        {
          deploymentRouteKey: "unmatched-chain:fusd-finchain:future-network",
          supplyUsd: 1,
          supplyShare: 0.2,
          reviewState: "unmatched" as const,
        },
      ],
      selectedRouteSupplyShare: 0.8,
      unknownRouteSupplyShare: 0.2,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [],
    };
    const chainRows = Object.fromEntries([
      ...routes.map((candidate) => [candidate.destinationChain, { current: 1 }]),
      ["Future Network", { current: 1 }],
    ]);
    const adapted = adaptBridgeFixture(
      meta("fusd-finchain", { bridgeRouteRisk: profile }),
      supplyReview,
      chainRows,
      v9TestClockSec(),
    );

    expect(adapted.review.status.applicability.state).toBe("required");
    expect(adapted.review.diagnostics).toMatchObject({
      profileRouteCount: 4,
      canonicalSupplyRowCount: 4,
      unmatchedRowIdentities: ["Future Network"],
      reviewedNativeCoverage: {
        reviewedRowCount: 4,
        canonicalSupplyRowCount: 4,
        supplyShare: 0.8,
        complete: false,
      },
      applicabilityBranch: "applicable",
    });
    // ODR-D5a: the four native rows join bridge controls, and the $1 unmatched
    // row is at the common-mode floor, so all five are named as unproven with
    // their deploymentRouteKey — the diagnostic that was previously absent.
    expect(
      adapted.review.diagnostics?.unprovenRouteJoins.map((row) => row.deploymentRouteKey),
    ).toEqual([
      ...routes.map((candidate) => candidate.id).sort(),
      "unmatched-chain:fusd-finchain:future-network",
    ].sort());
  });

  it("records no unproven bridge row when every selected row is a tolerated dust remainder", () => {
    // ODR-D5a: the two forgiven sub-threshold branches must stay silent, so a
    // clean asset does not grow a diagnostics payload it cannot act on.
    const profile = fusdRiskReview.bridgeRouteRisk as BridgeRouteRiskProfile;
    const routes = profile.routes ?? [];
    const supplyReview: NonNullable<Parameters<typeof adaptBridgeReview>[1]> = {
      selectedBridgeRoutes: [
        {
          deploymentRouteKey: "unmatched-chain:fusd-finchain:future-network",
          supplyUsd: 1,
          supplyShare: 0.0001,
          reviewState: "unmatched" as const,
        },
      ],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0.0001,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [],
    };
    const chainRows = Object.fromEntries([
      ...routes.map((candidate) => [candidate.destinationChain, { current: 1 }]),
      ["Future Network", { current: 1 }],
    ]);
    const adapted = adaptBridgeFixture(
      meta("fusd-finchain", { bridgeRouteRisk: profile }),
      supplyReview,
      chainRows,
      v9TestClockSec(),
    );

    expect(adapted.review.diagnostics?.unprovenRouteJoins).toEqual([]);
  });

  it("keeps a reviewed representation route bridge-applicable", () => {
    const mixedRoutes = [route(ETHEREUM_ROUTE), representationRoute(BASE_ROUTE)];
    const mixed = meta("fixture-mixed-native-and-representation", {
      status: "active",
      contracts: mixedRoutes.map((candidate) => ({
        chain: candidate.destinationChain,
        address: candidate.contractAddress,
        decimals: 18,
      })),
      bridgeRouteRisk: bridgeProfile(mixedRoutes, {
        controls: [bridgeControl({ routeRefs: [BASE_ROUTE] })],
      }),
    });

    const adapted = adaptBridgeFixture(mixed, null);

    expect(adapted.review.status.applicability.state).toBe("required");
    expect(adapted.review.routes.length).toBe(1);
  });

  it("stays bridge-applicable when an unresolved deployment carries structured controls", () => {
    // Repro of the cash-phantom / wclp-ripio shape: reviewed native routes plus one
    // deployment the reviewer could not classify, governed by real bridge controls at
    // zero attributed share. An unresolved deployment is not proof of no bridge.
    const unresolvedDeployment = route(BASE_ROUTE, {
      routeClass: "unknown",
      issuanceModel: "unknown",
      semantics: "unknown",
      scope: "unknown",
      riskTier: "opaque-or-unknown",
      reviewDisposition: "unresolved",
    });
    const withUnresolved = meta("fixture-unresolved-deployment", {
      status: "active",
      contracts: [
        {
          chain: "ethereum",
          address: ETHEREUM_ROUTE.slice(ETHEREUM_ROUTE.indexOf(":") + 1),
          decimals: 18,
        },
        {
          chain: unresolvedDeployment.destinationChain,
          address: unresolvedDeployment.contractAddress,
          decimals: 18,
        },
      ],
      bridgeRouteRisk: bridgeProfile([route(ETHEREUM_ROUTE), unresolvedDeployment], {
        controls: [
          bridgeControl({
            id: "fixture-oft-admin",
            routeRefs: [ETHEREUM_ROUTE, BASE_ROUTE],
          }),
        ],
      }),
    });

    const adapted = adaptBridgeFixture(withUnresolved, null);

    expect(adapted.review.status.applicability.state).toBe("required");
  });

  it("compiles a reviewed external-only representation as a not-applicable mint section", () => {
    const representation = representationRoute(BASE_ROUTE);
    const externalOnly = meta("fixture-external-only-representation", {
      status: "active",
      contracts: [
        {
          chain: representation.destinationChain,
          address: representation.contractAddress,
          decimals: 18,
        },
      ],
      mintAuthority: mintProfile({
        mintPath: "unknown",
        controls: [],
        review: {
          sources: [SOURCE],
          evidence: "The fixture has no local canonical issuance.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
          noLocalIssuance: {
            kind: "external-only-representation",
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            rationale: "Every authored deployment is an external representation.",
          },
        },
      }),
      bridgeRouteRisk: bridgeProfile([representation]),
    });

    const { extension } = compileFixture(externalOnly);
    const mint = extension.assets[0]!.economicControlReview!.mint;

    expect(mint.status.applicability.state).toBe("not-applicable");
    expect(mint.controlKey).toBeNull();
    expect(mint.reconciliation).toBe("not-applicable");
  });

  it("refuses a not-applicable mint section for an inherited claim with no serial dependency", () => {
    const nativeRoute = route(ETHEREUM_ROUTE);
    const inheritedWithoutEdge = meta("fixture-inherited-without-edge", {
      status: "active",
      contracts: [
        {
          chain: nativeRoute.destinationChain,
          address: nativeRoute.contractAddress,
          decimals: 18,
        },
      ],
      mintAuthority: mintProfile({
        mintPath: "wrapped-or-variant-inherited",
        inheritedFrom: "usdc-circle",
        controls: [],
        review: {
          sources: [SOURCE],
          evidence: "The fixture inherits issuance from its parent.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
          noLocalIssuance: {
            kind: "inherited-parent-issuance",
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            rationale: "Issuance is the parent's; this deployment holds no local minter.",
          },
        },
      }),
      bridgeRouteRisk: bridgeProfile([representationRoute(BASE_ROUTE)]),
    });

    const { extension } = compileFixture(inheritedWithoutEdge);
    const mint = extension.assets[0]!.economicControlReview!.mint;

    // No compiled serial-claim edge to the parent means the parent's mint risk
    // lands nowhere. The section must stay required and fail closed.
    expect(mint.status.applicability.state).toBe("required");
  });

  it("refuses a not-applicable mint section when the profile still authors controls", () => {
    const representation = representationRoute(BASE_ROUTE);
    const withControls = meta("fixture-external-only-with-controls", {
      status: "active",
      contracts: [
        {
          chain: representation.destinationChain,
          address: representation.contractAddress,
          decimals: 18,
        },
      ],
      mintAuthority: mintProfile({
        mintPath: "unknown",
        controls: [
          mintControl({
            chain: "base",
            role: "proxy-admin",
            directMintAbility: "upgrade-only",
          }),
        ],
        review: {
          sources: [SOURCE],
          evidence: "The fixture authors a local upgrade control alongside its exception.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
          noLocalIssuance: {
            kind: "external-only-representation",
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            rationale: "Every authored deployment is an external representation.",
          },
        },
      }),
      bridgeRouteRisk: bridgeProfile([representation]),
    });

    const { extension } = compileFixture(withControls);
    const mint = extension.assets[0]!.economicControlReview!.mint;

    expect(mint.status.applicability.state).toBe("required");
  });
});
