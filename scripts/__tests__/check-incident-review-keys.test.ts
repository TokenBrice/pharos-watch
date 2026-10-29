import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkIncidentReviewKeys,
  INCIDENT_REVIEWS_PATH,
  runIncidentReviewKeyCheck,
} from "../ci/check-incident-review-keys";

const ASSET = "alpha-fixture";
const ROUTE = "ethereum:0x1111111111111111111111111111111111111111";
const MINT_KEY = `mint-meta:${ASSET}:0123456789abcdef0123`;

interface FixtureOptions {
  reviews?: unknown[];
  rows?: unknown[];
  coin?: unknown;
  risk?: unknown;
  mint?: unknown;
}

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeJson(dir: string, path: string, value: unknown): void {
  const absolute = join(dir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function laneReview(reviewId = "review-lane", windowEndSec = 1000): unknown {
  return {
    reviewId,
    assetId: ASSET,
    scope: { kind: "control", routeId: ROUTE, controlId: "*" },
    reviewedAt: "2026-10-22",
    windowEndSec,
  };
}

function aggregateReview(reviewId = "review-aggregate", windowEndSec = 2000): unknown {
  return {
    reviewId,
    assetId: ASSET,
    scope: { kind: "control", routeId: ROUTE, controlIds: ["alpha-guard", "alpha-owner"] },
    reviewedAt: "2026-10-22",
    windowEndSec,
  };
}

function singleReview(reviewId = "review-single", windowEndSec = 3000): unknown {
  return {
    reviewId,
    assetId: ASSET,
    scope: { kind: "control", routeId: ROUTE, controlId: "alpha-owner" },
    reviewedAt: "2026-10-22",
    windowEndSec,
  };
}

function mintReview(reviewId = "review-mint", windowEndSec = 4000): unknown {
  return {
    reviewId,
    assetId: ASSET,
    scope: { kind: "control", controlKey: MINT_KEY },
    reviewedAt: "2026-10-22",
    windowEndSec,
  };
}

function deploymentReview(reviewId = "review-deploy"): unknown {
  return {
    reviewId,
    assetId: ASSET,
    scope: { kind: "deployment", deploymentKey: ROUTE, controlKinds: ["bridge"] },
    reviewedAt: "2026-10-22",
    windowEndSec: 5000,
  };
}

function deploymentMintReview(reviewId = "review-mint-deploy", windowEndSec = 1100): unknown {
  return {
    reviewId,
    assetId: ASSET,
    scope: { kind: "control", routeId: ROUTE, controlId: "Alpha route owner" },
    reviewedAt: "2026-10-22",
    windowEndSec,
  };
}

function retiredReview(reviewId = "review-retired"): unknown {
  return {
    reviewId,
    assetId: ASSET,
    scope: { kind: "control", controlKey: `bridge-meta:${ASSET}:deadbeefdeadbeefdead` },
    reviewedAt: "2026-10-11",
    windowEndSec: 6000,
    retired: { reviewedAt: "2026-10-29", reviewer: "fixture reviewer", reason: "orphan digest adjudicated as retired" },
  };
}

function migrationRow(
  reviewId: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    reviewId,
    assetId: ASSET,
    legacyControlKey: null,
    resolution: "lane",
    authored: { assetId: ASSET, routeId: ROUTE, controlId: "*" },
    applied: "authored",
    digestMatch: true,
    stableReviewId: `bridge:${ASSET}:${ROUTE}:lane:1000`,
    ...overrides,
  };
}

function fixtureRoot(options: FixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "incident-review-keys-"));
  cleanups.push(dir);
  const reviews = options.reviews ?? [
    laneReview(),
    aggregateReview(),
    singleReview(),
    deploymentMintReview(),
    mintReview(),
    deploymentReview(),
    retiredReview(),
  ];
  const rows = options.rows ?? [
    migrationRow("review-lane"),
    migrationRow("review-aggregate", {
      authored: { assetId: ASSET, routeId: ROUTE, controlIds: ["alpha-guard", "alpha-owner"] },
      stableReviewId: `bridge:${ASSET}:${ROUTE}:lane:2000`,
    }),
    migrationRow("review-single", {
      resolution: "control",
      authored: { assetId: ASSET, routeId: ROUTE, controlId: "alpha-owner" },
      stableReviewId: `bridge:${ASSET}:${ROUTE}:alpha-owner:3000`,
    }),
    migrationRow("review-mint-deploy", {
      legacyControlKey: `mint-meta:${ASSET}:fedcba9876543210fedc`,
      resolution: "mint-control",
      authored: { assetId: ASSET, routeId: ROUTE, controlId: "Alpha route owner" },
      stableReviewId: `mint:${ASSET}:alpha-route-owner:1100`,
    }),
    migrationRow("review-mint", {
      legacyControlKey: MINT_KEY,
      resolution: "mint-control",
      authored: { assetId: ASSET, controlId: "Alpha mint owner" },
      applied: "legacy-blocked",
      stableReviewId: `mint:${ASSET}:alpha-mint-owner:4000`,
    }),
    migrationRow("review-deploy", {
      resolution: "deployment",
      authored: { assetId: ASSET },
      applied: "unchanged",
      stableReviewId: "review-deploy",
    }),
    migrationRow("review-retired", {
      legacyControlKey: `bridge-meta:${ASSET}:deadbeefdeadbeefdead`,
      resolution: "retired",
      authored: null,
      applied: "retired",
      digestMatch: false,
      stableReviewId: "review-retired",
      reason: "orphan digest adjudicated as retired",
    }),
  ];
  writeJson(dir, "shared/data/stablecoins/coins/alpha-fixture.json", options.coin ?? {
    id: ASSET,
    contracts: [{ chain: "ethereum", address: "0x1111111111111111111111111111111111111111" }],
  });
  writeJson(dir, "shared/data/stablecoins/domains/risk-review/alpha-fixture.json", options.risk ?? {
    id: ASSET,
    bridgeRouteRisk: {
      routes: [{ id: ROUTE }],
      controls: [
        { id: "alpha-guard", routeRefs: [ROUTE] },
        { id: "alpha-owner", routeRefs: [ROUTE] },
      ],
    },
  });
  writeJson(dir, "shared/data/stablecoins/domains/mint-authority/alpha-fixture.json", options.mint ?? {
    id: ASSET,
    mintAuthority: {
      controls: [
        { label: "Alpha mint owner" },
        { label: "Alpha route owner", deploymentRefs: [ROUTE] },
      ],
    },
  });
  writeJson(dir, INCIDENT_REVIEWS_PATH, {
    schemaVersion: 1,
    incidents: [],
    negativeReviews: reviews,
    sourceObservations: [],
    searchedSurfaceObservations: [],
  });
  writeJson(dir, "shared/data/safety-score-v9/incident-review-key-migration-v1.generated.json", {
    schemaVersion: 2,
    generatedFrom: {},
    counts: {},
    rows,
  });
  return dir;
}

function codes(dir: string): string[] {
  return checkIncidentReviewKeys(dir).findings.map((finding) => finding.code);
}

describe("incident review keys pass on migrated rows", () => {
  it("accepts lane, aggregate, single-control, legacy mint, deployment and retired identities", () => {
    const report = checkIncidentReviewKeys(fixtureRoot());
    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ reviews: 7, live: 6, retired: 1, legacyDigestHeld: 1 });
  });

  it("accepts provider and issuer-surface rows without migration rows and validates covered lanes", () => {
    const dir = fixtureRoot({
      reviews: [
        {
          reviewId: "review-provider",
          scope: {
            kind: "provider",
            providerKey: "layerzero",
            surface: "dvn-set",
            coveredRoutes: [{ assetId: ASSET, routeId: ROUTE }],
            coveredControls: [{ assetId: ASSET, controlId: "alpha-owner" }],
          },
          reviewedAt: "2026-10-22",
          windowEndSec: 7000,
          laneScreeningRefs: [{ assetId: ASSET, routeId: ROUTE, certificateId: "certificate-fixture" }],
        },
        {
          reviewId: "review-issuer",
          assetId: ASSET,
          scope: { kind: "issuer-surface", coveredRoutes: [ROUTE], coveredControls: ["alpha-owner"] },
          reviewedAt: "2026-10-22",
          windowEndSec: 8000,
        },
      ],
      rows: [],
    });
    expect(checkIncidentReviewKeys(dir).findings).toEqual([]);
  });
});

describe("incident review keys report orphans and digest rows", () => {
  it("rejects an authored lane whose route is not compiled", () => {
    const dir = fixtureRoot({
      reviews: [{ ...(laneReview() as Record<string, unknown>), scope: { kind: "control", routeId: "base:0x2222222222222222222222222222222222222222", controlId: "*" } }],
      rows: [migrationRow("review-lane", { authored: { assetId: ASSET, routeId: "base:0x2222222222222222222222222222222222222222", controlId: "*" } })],
    });
    expect(codes(dir)).toEqual(["orphan-key"]);
  });

  it("rejects an aggregate that names a non-contributor control", () => {
    const dir = fixtureRoot({
      reviews: [{ ...(aggregateReview() as Record<string, unknown>), scope: { kind: "control", routeId: ROUTE, controlIds: ["alpha-owner", "ghost-control"] } }],
      rows: [migrationRow("review-aggregate", {
        authored: { assetId: ASSET, routeId: ROUTE, controlIds: ["alpha-owner", "ghost-control"] },
        stableReviewId: `bridge:${ASSET}:${ROUTE}:lane:2000`,
      })],
    });
    expect(codes(dir)).toEqual(["orphan-key"]);
  });

  it("rejects an exact control that is not compiled on its route", () => {
    const dir = fixtureRoot({
      reviews: [{ ...(singleReview() as Record<string, unknown>), scope: { kind: "control", routeId: ROUTE, controlId: "ghost-control" } }],
      rows: [migrationRow("review-single", {
        resolution: "control",
        authored: { assetId: ASSET, routeId: ROUTE, controlId: "ghost-control" },
        stableReviewId: `bridge:${ASSET}:${ROUTE}:ghost-control:3000`,
      })],
    });
    expect(codes(dir)).toEqual(["orphan-key"]);
  });

  it("rejects a live bridge digest that the migration should have authored", () => {
    const dir = fixtureRoot({
      reviews: [{ ...(laneReview() as Record<string, unknown>), scope: { kind: "control", controlKey: `bridge-meta:${ASSET}:aaaaaaaaaaaaaaaaaaaa` } }],
      rows: [migrationRow("review-lane", { legacyControlKey: `bridge-meta:${ASSET}:aaaaaaaaaaaaaaaaaaaa` })],
    });
    expect(codes(dir)).toEqual(["migration-state", "digest-key"]);
  });

  it("rejects a legacy digest row that the migration artefact does not name", () => {
    const dir = fixtureRoot({ reviews: [mintReview()], rows: [] });
    expect(codes(dir)).toEqual(["digest-key"]);
  });

  it("rejects a held mint digest that does not re-derive from a compiled mint control", () => {
    const dir = fixtureRoot({
      reviews: [mintReview()],
      rows: [migrationRow("review-mint", {
        legacyControlKey: MINT_KEY,
        resolution: "mint-control",
        authored: { assetId: ASSET, controlId: "Alpha mint owner" },
        applied: "legacy-blocked",
        digestMatch: false,
        stableReviewId: `mint:${ASSET}:alpha-mint-owner:4000`,
      })],
    });
    expect(codes(dir)).toEqual(["digest-key-orphan"]);
  });

  it("rejects a review whose asset has no compiled metadata", () => {
    const dir = fixtureRoot({
      reviews: [{ ...(laneReview() as Record<string, unknown>), assetId: "beta-fixture" }],
      rows: [migrationRow("review-lane", { assetId: "beta-fixture", authored: { assetId: "beta-fixture", routeId: ROUTE, controlId: "*" } })],
    });
    expect(codes(dir)).toEqual(expect.arrayContaining(["unknown-asset", "orphan-key"]));
  });
});

describe("incident review keys enforce retirement and migration state", () => {
  it("rejects a deployment-split mint control whose label is not bound to that route", () => {
    const dir = fixtureRoot({
      reviews: [deploymentMintReview()],
      rows: [migrationRow("review-mint-deploy", {
        resolution: "mint-control",
        authored: { assetId: ASSET, routeId: ROUTE, controlId: "Alpha route owner" },
        stableReviewId: `mint:${ASSET}:alpha-route-owner:1100`,
      })],
      mint: { id: ASSET, mintAuthority: { controls: [{ label: "Alpha route owner", deploymentRefs: ["base:0x4444444444444444444444444444444444444444"] }] } },
    });
    expect(codes(dir)).toEqual(["orphan-key"]);
  });

  it("rejects a deployment-split mint stable id written with the bridge prefix", () => {
    const dir = fixtureRoot({
      reviews: [deploymentMintReview()],
      rows: [migrationRow("review-mint-deploy", {
        resolution: "mint-control",
        authored: { assetId: ASSET, routeId: ROUTE, controlId: "Alpha route owner" },
        stableReviewId: `bridge:${ASSET}:${ROUTE}:alpha-route-owner:1100`,
      })],
    });
    expect(codes(dir)).toEqual(["stable-id"]);
  });

  it("rejects a retired review whose migration row is not retired", () => {
    const dir = fixtureRoot({
      reviews: [retiredReview()],
      rows: [migrationRow("review-retired", { applied: "authored", resolution: "lane" })],
    });
    expect(codes(dir)).toEqual(expect.arrayContaining(["migration-state", "stable-id"]));
  });

  it("rejects a retirement whose migration row carries no reason", () => {
    const dir = fixtureRoot({
      reviews: [retiredReview()],
      rows: [migrationRow("review-retired", {
        legacyControlKey: `bridge-meta:${ASSET}:deadbeefdeadbeefdead`,
        resolution: "retired",
        authored: null,
        applied: "retired",
        digestMatch: false,
        stableReviewId: "review-retired",
        reason: "  ",
      })],
    });
    expect(codes(dir)).toEqual(["retired-reason"]);
  });

  it("rejects a retirement without a machine reason at the schema boundary", () => {
    const dir = fixtureRoot({
      reviews: [{ ...(retiredReview() as Record<string, unknown>), retired: { reviewedAt: "2026-10-29", reviewer: "fixture reviewer" } }],
      rows: [],
    });
    expect(codes(dir)).toEqual(["review-schema"]);
  });

  it("rejects a live digest row the artefact records as authored", () => {
    const dir = fixtureRoot({
      reviews: [mintReview()],
      rows: [migrationRow("review-mint", {
        legacyControlKey: MINT_KEY,
        resolution: "mint-control",
        authored: { assetId: ASSET, controlId: "Alpha mint owner" },
        applied: "authored",
        stableReviewId: `mint:${ASSET}:alpha-mint-owner:4000`,
      })],
    });
    expect(codes(dir)).toEqual(["migration-state"]);
  });

  it("rejects a stored authored identity that differs from the migration artefact", () => {
    const dir = fixtureRoot({
      reviews: [singleReview()],
      rows: [migrationRow("review-single", {
        resolution: "control",
        authored: { assetId: ASSET, routeId: ROUTE, controlId: "alpha-guard" },
        stableReviewId: `bridge:${ASSET}:${ROUTE}:alpha-guard:3000`,
      })],
    });
    expect(codes(dir)).toEqual(["migration-identity"]);
  });

  it("rejects migration rows for reviews that do not exist", () => {
    const dir = fixtureRoot({ reviews: [laneReview()], rows: [migrationRow("review-lane"), migrationRow("review-ghost")] });
    expect(codes(dir)).toEqual(["migration-row-extra"]);
  });
});

describe("incident review keys enforce stable ids", () => {
  it("rejects a stable id without the bridge prefix", () => {
    const dir = fixtureRoot({
      reviews: [laneReview()],
      rows: [migrationRow("review-lane", { stableReviewId: `lane:${ASSET}:${ROUTE}:lane:1000` })],
    });
    expect(codes(dir)).toEqual(["stable-id"]);
  });

  it("rejects a stable id that does not end at the review window", () => {
    const dir = fixtureRoot({
      reviews: [laneReview()],
      rows: [migrationRow("review-lane", { stableReviewId: `bridge:${ASSET}:${ROUTE}:lane:999` })],
    });
    expect(codes(dir)).toEqual(["stable-id"]);
  });

  it("rejects duplicate stable ids across reviewIds", () => {
    const dir = fixtureRoot({
      reviews: [laneReview("review-lane-one"), laneReview("review-lane-two")],
      rows: [migrationRow("review-lane-one"), migrationRow("review-lane-two")],
    });
    expect(codes(dir)).toEqual(["stable-id-duplicate"]);
  });

  it("rejects duplicate reviewIds", () => {
    const dir = fixtureRoot({
      reviews: [laneReview(), laneReview()],
      rows: [migrationRow("review-lane")],
    });
    expect(codes(dir)).toEqual(["review-id-duplicate", "stable-id-duplicate"]);
  });
});

describe("incident review coverer references", () => {
  const provider = (laneScreeningRefs: unknown[] | undefined): unknown => ({
    reviewId: "review-provider",
    scope: {
      kind: "provider",
      providerKey: "hyperlane",
      surface: "ism-validator-set",
      coveredRoutes: [{ assetId: ASSET, routeId: ROUTE }],
    },
    reviewedAt: "2026-10-22",
    windowEndSec: 9000,
    ...(laneScreeningRefs === undefined ? {} : { laneScreeningRefs }),
  });

  it("rejects a provider review without lane screening references", () => {
    const dir = fixtureRoot({ reviews: [provider(undefined)], rows: [] });
    expect(codes(dir)).toEqual(["coverage-ref-missing"]);
  });

  it("rejects a screening reference that names an uncovered lane", () => {
    const dir = fixtureRoot({
      reviews: [provider([{ assetId: ASSET, routeId: "base:0x3333333333333333333333333333333333333333", certificateId: "certificate-fixture" }])],
      rows: [],
    });
    expect(codes(dir)).toEqual(expect.arrayContaining(["coverage-ref-lane", "coverage-ref-missing"]));
  });
});

describe("incident review key CLI", () => {
  it("passes on a clean fixture and prints the census line", () => {
    const dir = fixtureRoot();
    const stdout = { write: vi.fn(() => true) };
    const stderr = { write: vi.fn(() => true) };
    expect(runIncidentReviewKeyCheck([], dir, stdout, stderr)).toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(
      "incident-review keys: 7 reviews (6 live, 1 retired, 1 legacy digest held) — 0 finding(s)\n",
    );
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("fails with findings and rejects unknown arguments", () => {
    const dir = fixtureRoot({ reviews: [{ ...(laneReview() as Record<string, unknown>), assetId: "beta-fixture" }], rows: [] });
    const stdout = { write: vi.fn(() => true) };
    const stderr = { write: vi.fn(() => true) };
    expect(runIncidentReviewKeyCheck([], dir, stdout, stderr)).toBe(1);
    expect(stdout.write.mock.calls.map(([line]) => String(line)).join("")).toContain("[unknown-asset]");
    expect(runIncidentReviewKeyCheck(["--strict"], dir, stdout, stderr)).toBe(2);
    expect(stderr.write).toHaveBeenCalledWith("Unknown argument: --strict\n");
  });

  it("reports a broken registry as a check failure instead of a traceback", () => {
    const dir = fixtureRoot();
    writeJson(dir, INCIDENT_REVIEWS_PATH, { schemaVersion: 1 });
    const stdout = { write: vi.fn(() => true) };
    const stderr = { write: vi.fn(() => true) };
    expect(runIncidentReviewKeyCheck([], dir, stdout, stderr)).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("has no negativeReviews array"));
  });
});
