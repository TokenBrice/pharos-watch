import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  BridgeRouteControl,
  BridgeRouteDeployment,
  BridgeRouteRiskProfile,
  ContractDeployment,
  MintAuthorityControl,
  MintAuthorityProfile,
  StablecoinMeta,
} from "@shared/types/core";
import { describe, expect, it } from "vitest";
import { parseStablecoinMetaAssets } from "../schema";
import {
  validateMintBridgeOwnership,
  type MintBridgeOwnershipViolation,
} from "../mint-bridge-ownership";

const SOURCE = { label: "Fixture review", url: "https://example.com/review" };
const ETHEREUM_TOKEN = "0x1111111111111111111111111111111111111111";
const ARBITRUM_TOKEN = "0x2222222222222222222222222222222222222222";
const BASE_TOKEN = "0x3333333333333333333333333333333333333333";
const POLYGON_TOKEN = "0x4444444444444444444444444444444444444444";
const ETHEREUM_ROUTE = `ethereum:${ETHEREUM_TOKEN}`;
const ARBITRUM_ROUTE = `arbitrum:${ARBITRUM_TOKEN}`;
const BASE_ROUTE = `base:${BASE_TOKEN}`;
const POLYGON_ROUTE = `polygon:${POLYGON_TOKEN}`;

const baseFlags = {
  pegCurrency: "USD" as const,
  governance: "centralized" as const,
  backing: "rwa-backed" as const,
  yieldBearing: false,
  rwa: true,
  navToken: false,
};

function makeRoute(
  id: string,
  overrides: Partial<BridgeRouteDeployment> = {},
): BridgeRouteDeployment {
  const separator = id.indexOf(":");
  const chain = id.slice(0, separator);
  const address = id.slice(separator + 1);
  return {
    id,
    destinationChain: chain,
    contractAddress: address,
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

function makeBridgeProfile(
  routes: BridgeRouteDeployment[],
  controls?: BridgeRouteControl[],
): BridgeRouteRiskProfile {
  return {
    tier: "issuer-native-burn-mint",
    summary: "The fixture has reviewed native and transfer-rail deployments.",
    reviewedAt: "1970-01-01",
    reviewer: "Fixture reviewer",
    confidence: "verified",
    sources: [SOURCE],
    routes,
    ...(controls === undefined ? {} : { controls }),
  };
}

function makeMintControl(
  overrides: Partial<MintAuthorityControl> = {},
): MintAuthorityControl {
  return {
    chain: "arbitrum",
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: "Fixture native issuer",
    role: "direct-minter",
    authorityType: "contract",
    directMintAbility: "direct",
    sources: [SOURCE],
    ...overrides,
  };
}

function makeMintProfile(
  overrides: Partial<MintAuthorityProfile> = {},
): MintAuthorityProfile {
  return {
    mintPath: "issuer-direct-mint",
    authorityPosture: "partially-bounded-admin",
    confidence: "verified",
    summary: "The fixture has a reviewed native issuance authority.",
    controls: [makeMintControl()],
    review: {
      sources: [SOURCE],
      evidence: "The fixture review identifies the native issuance authority.",
      reviewer: "Fixture reviewer",
      reviewedAt: "1970-01-01",
    },
    ...overrides,
  };
}

function contractsFor(routeIds: readonly string[]): ContractDeployment[] {
  return routeIds.map((id) => {
    const separator = id.indexOf(":");
    return {
      chain: id.slice(0, separator),
      address: id.slice(separator + 1),
      decimals: 18,
    };
  });
}

function makeCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "fixture-usd",
    name: "Fixture USD",
    symbol: "FUSD",
    flags: baseFlags,
    ...overrides,
  } as StablecoinMeta;
}

function bridgeControl(
  overrides: Partial<BridgeRouteControl> = {},
): BridgeRouteControl {
  return {
    id: "fixture-transfer-control",
    label: "Fixture bridge transfer controller",
    routeRefs: [ARBITRUM_ROUTE],
    capabilities: ["bridge-mint"],
    controllerChain: "arbitrum",
    controllerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    authorityType: "contract",
    sources: [SOURCE],
    ...overrides,
  };
}

function representationRoute(
  id: string,
  overrides: Partial<BridgeRouteDeployment> = {},
): BridgeRouteDeployment {
  return makeRoute(id, {
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

function violationCodes(
  violations: readonly MintBridgeOwnershipViolation[],
): string[] {
  return violations.map((violation) => violation.code);
}

function formatOwnershipViolations(
  violations: readonly MintBridgeOwnershipViolation[],
): string {
  if (violations.length === 0) return "no ownership violations";
  return violations
    .map(
      (violation) =>
        `${violation.assetId} ${violation.path} [${violation.code}] (${violation.severity}): ${violation.message}`,
    )
    .join("\n");
}

function expectNoOwnershipViolations(
  violations: readonly MintBridgeOwnershipViolation[],
): void {
  expect(violations, formatOwnershipViolations(violations)).toEqual([]);
}

const ACTIVE_ONLY_VIOLATION_CODES: ReadonlySet<MintBridgeOwnershipViolation["code"]> = new Set([
  "representation-route-without-bridge-mint",
  "bridge-capability-in-mint",
  "missing-mint-deployment-refs",
  "missing-native-deployment",
]);

const NON_ACTIVE_LIFECYCLE_STATUSES = [
  "pre-launch",
  "frozen",
  "quarantined",
  "delisted",
] as const;

describe("Mint Authority / Bridge Risk ownership boundary", () => {
  it.each(["usdai-usd-ai", "susdai-usd-ai"])(
    "%s keeps canonical Arbitrum issuance in Mint Authority and satellite issuance in Bridge Risk",
    (assetId) => {
      const meta = ACTIVE_META_BY_ID.get(assetId);
      if (!meta?.mintAuthority || !meta.bridgeRouteRisk?.routes) {
        throw new Error(`expected boundary metadata for ${assetId}`);
      }
      const nativeRoute = meta.bridgeRouteRisk.routes.find(
        (route) => route.issuanceModel === "native-issuance",
      );
      if (!nativeRoute) throw new Error(`expected canonical route for ${assetId}`);

      expect(nativeRoute.id).toBe(`arbitrum:${nativeRoute.contractAddress.toLowerCase()}`);
      expect(meta.mintAuthority.controls?.length).toBeGreaterThan(0);
      expect(meta.mintAuthority.controls?.every((control) => control.chain === "arbitrum")).toBe(true);
      expect(
        meta.mintAuthority.controls?.some(
          (control) => control.role === "bridge-admin" || control.authorityType === "bridge" || control.routeChecks,
        ),
      ).toBe(false);

      const satelliteRoutes = meta.bridgeRouteRisk.routes.filter(
        (route) => route.issuanceModel !== "native-issuance",
      );
      expect(satelliteRoutes.length).toBeGreaterThan(0);
      expect(satelliteRoutes.every((route) => route.controllerChain && route.controllerAddress)).toBe(true);

      const violations = validateMintBridgeOwnership(meta);
      expect(violations.filter((violation) => violation.severity === "error")).toEqual([]);
    },
  );

  it("rejects a representation deployment referenced from Mint Authority at the schema boundary", () => {
    const representation = representationRoute(BASE_ROUTE);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeCoin({
            contracts: contractsFor([BASE_ROUTE]),
            mintAuthority: makeMintProfile({
              controls: [makeMintControl({ deploymentRefs: [representation.id] })],
            }),
            bridgeRouteRisk: makeBridgeProfile([representation]),
          }),
        ],
        "mint-bridge-fixture",
      ),
    ).toThrow("[mint-bridge-ownership:mint-ref-not-native]");
  });

  it("accepts a genuine multi-canonical issuer and every native deployment ref", () => {
    const routes = [
      makeRoute(ARBITRUM_ROUTE),
      makeRoute(BASE_ROUTE, { canonicalChain: "base", destinationChain: "base" }),
    ];
    const controls = routes.map((route, index) =>
      makeMintControl({
        label: `Native issuer ${index}`,
        chain: route.destinationChain,
        address: `0x${String(index + 1).repeat(40)}`,
        deploymentRefs: [route.id],
      }),
    );
    const meta = makeCoin({
      contracts: contractsFor(routes.map((route) => route.id)),
      mintAuthority: makeMintProfile({
        controls,
        upgradeability: {
          model: "transparent-proxy",
          deploymentRefs: routes.map((route) => route.id),
          canChangeMintLogic: true,
          controlRef: controls[0]!.label,
          sources: [SOURCE],
        },
      }),
      bridgeRouteRisk: makeBridgeProfile(routes),
    });

    expect(validateMintBridgeOwnership(meta, { enforce: true })).toEqual([]);
  });

  it("allows an issuer-native deployment and a separate transfer-pool control without double counting", () => {
    const routes = [
      makeRoute(ARBITRUM_ROUTE),
      makeRoute(BASE_ROUTE, { canonicalChain: "arbitrum", destinationChain: "base" }),
    ];
    const meta = makeCoin({
      contracts: contractsFor(routes.map((route) => route.id)),
      mintAuthority: makeMintProfile({
        controls: [makeMintControl({ deploymentRefs: [ARBITRUM_ROUTE] })],
      }),
      bridgeRouteRisk: makeBridgeProfile(routes, [
        bridgeControl({
          id: "issuer-native-transfer-pool",
          routeRefs: [BASE_ROUTE],
          capabilities: ["bridge-burn", "bridge-mint", "rate-limit", "peer-config"],
        }),
      ]),
    });

    expect(validateMintBridgeOwnership(meta, { enforce: true })).toEqual([]);
  });

  it.each(["bridge-representation", "wrapped-representation"] as const)(
    "requires bridge-mint when a reviewed %s route has structured coverage",
    (issuanceModel) => {
      const route = representationRoute(BASE_ROUTE, { issuanceModel });
      const meta = makeCoin({
        contracts: contractsFor([BASE_ROUTE]),
        bridgeRouteRisk: makeBridgeProfile([route], [
          bridgeControl({
            id: "admin-only-control",
            routeRefs: [BASE_ROUTE],
            capabilities: ["admin"],
          }),
        ]),
      });

      expect(validateMintBridgeOwnership(meta, { enforce: true })).toEqual([
        expect.objectContaining({
          code: "representation-route-without-bridge-mint",
          path: "bridgeRouteRisk.routes[0].id",
          message: `reviewed representation route "${BASE_ROUTE}" is covered by control IDs ["admin-only-control"], but none includes "bridge-mint"; name the bridge-mint holder in one of those controls, or stop referencing the route so the conservative route-derived fallback overlay applies`,
          severity: "error",
        }),
      ]);
    },
  );

  it("accepts structured representation coverage when a control names the bridge-mint holder", () => {
    const route = representationRoute(BASE_ROUTE);
    const meta = makeCoin({
      contracts: contractsFor([BASE_ROUTE]),
      bridgeRouteRisk: makeBridgeProfile([route], [
        bridgeControl({
          id: "reviewed-mint-control",
          routeRefs: [BASE_ROUTE],
          capabilities: ["admin", "bridge-mint"],
        }),
      ]),
    });

    expectNoOwnershipViolations(validateMintBridgeOwnership(meta, { enforce: true }));
  });

  it("keeps the conservative fallback when no structured control references a representation route", () => {
    const route = representationRoute(BASE_ROUTE);
    const meta = makeCoin({
      contracts: contractsFor([BASE_ROUTE]),
      bridgeRouteRisk: makeBridgeProfile([route]),
    });

    expectNoOwnershipViolations(validateMintBridgeOwnership(meta, { enforce: true }));
  });

  it("does not require bridge-mint for a native-issuance route with structured admin coverage", () => {
    const route = makeRoute(BASE_ROUTE);
    const meta = makeCoin({
      contracts: contractsFor([BASE_ROUTE]),
      bridgeRouteRisk: makeBridgeProfile([route], [
        bridgeControl({
          id: "canonical-adapter-admin",
          routeRefs: [BASE_ROUTE],
          capabilities: ["admin"],
        }),
      ]),
    });

    expectNoOwnershipViolations(validateMintBridgeOwnership(meta, { enforce: true }));
  });

  it("does not require bridge-mint for an unresolved representation route", () => {
    const route = representationRoute(BASE_ROUTE, {
      reviewDisposition: "unresolved",
      reviewNote: "The route review has not identified its transfer-rail controls yet.",
    });
    const meta = makeCoin({
      contracts: contractsFor([BASE_ROUTE]),
      bridgeRouteRisk: makeBridgeProfile([route], [
        bridgeControl({
          id: "unresolved-admin-control",
          routeRefs: [BASE_ROUTE],
          capabilities: ["admin"],
        }),
      ]),
    });

    expectNoOwnershipViolations(validateMintBridgeOwnership(meta, { enforce: true }));
  });

  it("allows one Safe to have distinct native-mint and bridge capabilities", () => {
    const sharedAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
    const meta = makeCoin({
      contracts: contractsFor([ARBITRUM_ROUTE]),
      mintAuthority: makeMintProfile({
        controls: [
          makeMintControl({
            address: sharedAddress,
            authorityType: "safe",
            deploymentRefs: [ARBITRUM_ROUTE],
            directMintAbility: "cap-limited",
          }),
        ],
      }),
      bridgeRouteRisk: makeBridgeProfile([makeRoute(ARBITRUM_ROUTE)], [
        bridgeControl({
          id: "shared-safe-bridge-rail",
          controllerAddress: sharedAddress,
          capabilities: ["bridge-mint", "peer-config"],
        }),
      ]),
    });

    expect(validateMintBridgeOwnership(meta, { enforce: true })).toEqual([]);
  });

  it("rejects the same bridge capability authored in both modules", () => {
    const sharedAddress = "0xdddddddddddddddddddddddddddddddddddddddd";
    const meta = makeCoin({
      contracts: contractsFor([ARBITRUM_ROUTE]),
      mintAuthority: makeMintProfile({
        controls: [
          makeMintControl({
            address: sharedAddress,
            role: "bridge-admin",
            directMintAbility: "none",
            deploymentRefs: [ARBITRUM_ROUTE],
          }),
        ],
      }),
      bridgeRouteRisk: makeBridgeProfile([makeRoute(ARBITRUM_ROUTE)], [
        bridgeControl({
          id: "duplicate-bridge-admin",
          controllerAddress: sharedAddress,
          capabilities: ["admin"],
        }),
      ]),
    });

    const violations = validateMintBridgeOwnership(meta, { enforce: true });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "bridge-capability-in-mint", severity: "error" }),
        expect.objectContaining({ code: "duplicate-cross-domain-capability", severity: "error" }),
      ]),
    );
  });

  it("requires a reviewed noLocalIssuance exception, rejects contradictions, and leaves inherited issuance fail-closed", () => {
    const routes = [representationRoute(ETHEREUM_ROUTE), representationRoute(BASE_ROUTE)];
    const contracts = contractsFor(routes.map((route) => route.id));
    const baseProfile = makeMintProfile({
      mintPath: "wrapped-or-variant-inherited",
      controls: [],
      inheritedFrom: "parent-fixture",
    });
    const noLocalIssuance = {
      kind: "inherited-parent-issuance" as const,
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      rationale: "This wrapper creates no local canonical liabilities and inherits issuance from its parent.",
      sources: [SOURCE],
    };
    const validMeta = makeCoin({
      id: "fixture-wrapper",
      contracts,
      mintAuthority: {
        ...baseProfile,
        review: { ...baseProfile.review, noLocalIssuance },
      },
      bridgeRouteRisk: makeBridgeProfile(routes),
    });
    expect(validateMintBridgeOwnership(validMeta, { enforce: true })).toEqual([]);

    const withoutException = structuredClone(validMeta);
    delete withoutException.mintAuthority!.review.noLocalIssuance;
    const migrationMissingExceptionViolations = validateMintBridgeOwnership(withoutException);
    expect(migrationMissingExceptionViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-native-deployment", severity: "warning" }),
      ]),
    );
    const missingExceptionViolations = validateMintBridgeOwnership(withoutException, { enforce: true });
    expect(missingExceptionViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-native-deployment", severity: "error" }),
      ]),
    );

    const contradictoryRoute = makeRoute(ARBITRUM_ROUTE);
    const contradictory = structuredClone(validMeta);
    contradictory.contracts = [...(contradictory.contracts ?? []), ...contractsFor([ARBITRUM_ROUTE])];
    contradictory.bridgeRouteRisk!.routes = [...(contradictory.bridgeRouteRisk!.routes ?? []), contradictoryRoute];
    const contradictoryViolations = validateMintBridgeOwnership(contradictory, { enforce: true });
    expect(contradictoryViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-no-local-issuance-exception", severity: "error" }),
      ]),
    );
    expect(violationCodes(validateMintBridgeOwnership(validMeta))).toEqual([]);
  });

  it("has no error-severity ownership violations across the active registry", () => {
    const violations = [...ACTIVE_META_BY_ID.values()].flatMap((meta) =>
      validateMintBridgeOwnership(meta).filter((violation) => violation.severity === "error"),
    );

    expectNoOwnershipViolations(violations);
  });

  it("enforces reviewed native deployment ownership for every active Mint Authority path", () => {
    const violations = [...ACTIVE_META_BY_ID.values()].flatMap((meta) =>
      validateMintBridgeOwnership(meta, { enforce: true }),
    );

    expectNoOwnershipViolations(violations);
  });

  it("keeps bridge vocabulary out of active Mint Authority data", () => {
    const violations: MintBridgeOwnershipViolation[] = [];

    for (const meta of ACTIVE_META_BY_ID.values()) {
      const mintAuthority = meta.mintAuthority;
      if (!mintAuthority) continue;

      if (mintAuthority.mintPath === "bridge-or-oft-synthetic") {
        violations.push({
          assetId: meta.id,
          code: "bridge-capability-in-mint",
          path: "mintAuthority.mintPath",
          message: `active Mint Authority mintPath is ${mintAuthority.mintPath}`,
          severity: "error",
        });
      }

      for (let index = 0; index < (mintAuthority.controls ?? []).length; index += 1) {
        const control = mintAuthority.controls![index]!;
        if (control.role === "bridge-admin") {
          violations.push({
            assetId: meta.id,
            code: "bridge-capability-in-mint",
            path: `mintAuthority.controls[${index}].role`,
            message: `active Mint Authority control role is ${control.role}`,
            severity: "error",
          });
        }
        if (control.authorityType === "bridge") {
          violations.push({
            assetId: meta.id,
            code: "bridge-capability-in-mint",
            path: `mintAuthority.controls[${index}].authorityType`,
            message: `active Mint Authority control authorityType is ${control.authorityType}`,
            severity: "error",
          });
        }
        if (control.routeChecks != null) {
          violations.push({
            assetId: meta.id,
            code: "bridge-capability-in-mint",
            path: `mintAuthority.controls[${index}].routeChecks`,
            message: "active Mint Authority control contains bridge routeChecks",
            severity: "error",
          });
        }
      }
    }

    expectNoOwnershipViolations(violations);
  });

  it.each(NON_ACTIVE_LIFECYCLE_STATUSES)(
    "%s assets are explicitly exempt from active enforce-mode assertions",
    (status) => {
      const assets = [...TRACKED_META_BY_ID.values()].filter((meta) => meta.status === status);
      expect(assets.length, `expected real catalog entries with status ${status}`).toBeGreaterThan(0);

      const activeIds = new Set(ACTIVE_META_BY_ID.keys());
      expect(
        assets.filter((meta) => activeIds.has(meta.id)),
        `status ${status} assets must not enter the active enforce-mode registry set: ${assets.map((meta) => meta.id).join(", ")}`,
      ).toEqual([]);

      const activeOnlyViolations = assets.flatMap((meta) =>
        validateMintBridgeOwnership(meta, { enforce: true }).filter((violation) =>
          ACTIVE_ONLY_VIOLATION_CODES.has(violation.code),
        ),
      );
      expectNoOwnershipViolations(activeOnlyViolations);
    },
  );
});
