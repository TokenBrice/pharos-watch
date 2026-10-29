import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  LANE_EMITTER_BOOTSTRAP_LOOKBACK_BLOCKS,
  buildLaneEmitterDescriptors,
  deriveLaneEmitterDescriptors,
  loadLaneControlRecords,
  parseRuntimeIdentity,
  type LaneControlRecord,
} from "../build-data/generate-safety-score-v9-lane-emitter-descriptors";
import { V9_LANE_ADMIN_EVENT_FAMILY_VALUES } from "../../shared/types/safety-score-v9-incidents";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ARTIFACT_PATH = resolve(ROOT, "shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json");
const CONTROLLER = "0x1111111111111111111111111111111111111111";
const OTHER_CONTROLLER = "0x2222222222222222222222222222222222222222";
const ROUTE = "ethereum:0x3333333333333333333333333333333333333333";
const SECOND_ROUTE = "base:0x4444444444444444444444444444444444444444";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const DECODED_IDENTITY = `sha256-decoded-runtime-bytes:${HASH}`;

function control(overrides: Partial<LaneControlRecord> = {}): LaneControlRecord {
  return {
    recordKind: "bridge-control",
    assetId: "fixture-asset",
    controlId: "fixture-control",
    routeRefs: [ROUTE],
    controllerChain: "ethereum",
    controllerAddress: CONTROLLER,
    runtimeIdentity: null,
    ...overrides,
  };
}

function derive(records: readonly LaneControlRecord[]) {
  return deriveLaneEmitterDescriptors({ records, sidecars: { riskReview: 1, mintAuthority: 0 } });
}

function uncoveredReason(runtimeIdentity: string | null): string {
  return derive([control({ runtimeIdentity })]).noReviewedEmitter[0]!.reason;
}

describe("lane emitter descriptors", () => {
  it("admits a route lane whose controller has a decoded-bytes runtime pin", () => {
    const artifact = derive([control({ runtimeIdentity: DECODED_IDENTITY })]);

    expect(artifact.descriptors).toEqual([{
      subjectDeploymentKey: ROUTE,
      emitters: [{
        address: CONTROLLER,
        expectedRuntimeCodeSha256: HASH,
        families: [...V9_LANE_ADMIN_EVENT_FAMILY_VALUES],
      }],
      lookbackBlocks: LANE_EMITTER_BOOTSTRAP_LOOKBACK_BLOCKS,
      provenance: {
        assetIds: ["fixture-asset"],
        controlIds: ["fixture-control"],
        pins: [{
          emitterAddress: CONTROLLER,
          recordKind: "bridge-control",
          assetId: "fixture-asset",
          controlId: "fixture-control",
        }],
      },
    }]);
    expect(artifact.summary).toMatchObject({ lanes: 1, covered: 1, noReviewedEmitter: 0 });
  });

  it("lists a route lane with no reviewed controller pin as no-reviewed-emitter", () => {
    const artifact = derive([control({ controllerChain: null, controllerAddress: null })]);

    expect(artifact.descriptors).toEqual([]);
    expect(artifact.noReviewedEmitter).toEqual([{
      subjectDeploymentKey: ROUTE,
      reason: "missing-runtime-identity",
      assetIds: ["fixture-asset"],
      controlIds: ["fixture-control"],
      unpinnedControlIds: ["fixture-control"],
    }]);
  });

  it("keeps an unlabelled digest out of the catalog and preserves it as the migration witness", () => {
    const artifact = derive([control({ runtimeIdentity: `sha256:${HASH}` })]);

    expect(artifact.descriptors).toEqual([]);
    expect(artifact.noReviewedEmitter[0]).toMatchObject({
      subjectDeploymentKey: ROUTE,
      reason: "runtime-identity-domain-unlabelled",
      reviewedRuntimeIdentities: [`sha256:${HASH}`],
    });
  });

  it("classifies every authored runtime-identity form it cannot admit", () => {
    expect(parseRuntimeIdentity(DECODED_IDENTITY, CONTROLLER)).toEqual({ state: "decoded", sha256: HASH });
    expect(uncoveredReason(null)).toBe("missing-runtime-identity");
    expect(uncoveredReason(`sha256:rpc-hex-text:${HASH}`)).toBe("runtime-identity-text-encoded");
    expect(uncoveredReason(`sha256-rpc-code-text:${HASH}`)).toBe("runtime-identity-text-encoded");
    expect(uncoveredReason(`keccak256:0x${"c".repeat(64)}`)).toBe("runtime-identity-non-sha256");
    expect(uncoveredReason(`ethereum:${OTHER_CONTROLLER}`)).toBe("runtime-identity-binds-other-address");
    expect(uncoveredReason(`ethereum:${OTHER_CONTROLLER}; runtime-sha256:${HASH}`))
      .toBe("runtime-identity-binds-other-address");
    expect(uncoveredReason(`proxy sha256:${HASH}; implementation ${OTHER_CONTROLLER} sha256:${OTHER_HASH}`))
      .toBe("runtime-identity-domain-unlabelled");
    expect(uncoveredReason("0x")).toBe("runtime-identity-without-sha256");
  });

  it("refuses a lane when one contributing control has no pinned controller", () => {
    const artifact = derive([
      control({ runtimeIdentity: DECODED_IDENTITY }),
      control({ controlId: "second-control", controllerChain: null, controllerAddress: null }),
    ]);

    expect(artifact.descriptors).toEqual([]);
    expect(artifact.noReviewedEmitter[0]).toMatchObject({
      subjectDeploymentKey: ROUTE,
      reason: "partial-emitter-runtime-identity",
      controlIds: ["fixture-control", "second-control"],
      unpinnedControlIds: ["second-control"],
    });
    expect(artifact.summary.noReviewedEmitterByReason["partial-emitter-runtime-identity"]).toBe(1);
  });

  it("uses a mint-control pin as the emitter identity for a matching bridge controller", () => {
    const artifact = derive([
      control({ routeRefs: [ROUTE], runtimeIdentity: null }),
      control({
        recordKind: "mint-control",
        assetId: "fixture-mint",
        controlId: "minter",
        routeRefs: [],
        runtimeIdentity: DECODED_IDENTITY,
      }),
    ]);

    expect(artifact.descriptors).toHaveLength(1);
    expect(artifact.descriptors[0]!.provenance).toEqual({
      assetIds: ["fixture-asset"],
      controlIds: ["fixture-control"],
      pins: [{
        emitterAddress: CONTROLLER,
        recordKind: "mint-control",
        assetId: "fixture-mint",
        controlId: "minter",
      }],
    });
  });

  it("refuses a controller whose records carry different decoded pins", () => {
    const artifact = derive([
      control({ runtimeIdentity: DECODED_IDENTITY }),
      control({ controlId: "second-control", runtimeIdentity: `sha256-decoded-runtime-bytes:${OTHER_HASH}` }),
    ]);

    expect(artifact.descriptors).toEqual([]);
    expect(artifact.noReviewedEmitter[0]).toMatchObject({
      subjectDeploymentKey: ROUTE,
      reason: "runtime-identity-hash-conflict",
    });
  });

  it("emits one lane per governed route and drops non-EVM routes", () => {
    const artifact = derive([
      control({ routeRefs: [ROUTE, SECOND_ROUTE], controllerChain: "ethereum", runtimeIdentity: DECODED_IDENTITY }),
      control({ routeRefs: [`solana:${"4".repeat(44)}`], controllerChain: "solana", controllerAddress: "4kw74JZfQSg7wtvZc5h2Guozayb3UUzNiuy8eZUEcqPj" }),
    ]);

    expect(artifact.descriptors.map((row) => row.subjectDeploymentKey)).toEqual([SECOND_ROUTE, ROUTE]);
    expect(artifact.summary.lanesNonEvm).toBe(1);
    expect(artifact.summary.controls.routeRefs).toEqual({ total: 3, nonEvm: 1, malformed: 0 });
  });

  it("normalizes a checksummed route and controller into one lane", () => {
    const artifact = derive([
      control({
        routeRefs: [`ethereum:0x${"AB".repeat(20)}`],
        controllerAddress: `0x${"CD".repeat(20)}`,
        runtimeIdentity: DECODED_IDENTITY,
      }),
      control({
        routeRefs: [`ethereum:0x${"ab".repeat(20)}`],
        controllerAddress: `0x${"cd".repeat(20)}`,
        assetId: "fixture-second",
      }),
    ]);

    expect(artifact.summary.lanes).toBe(1);
    expect(artifact.descriptors[0]!.subjectDeploymentKey).toBe(`ethereum:0x${"ab".repeat(20)}`);
    expect(artifact.descriptors[0]!.emitters[0]!.address).toBe(`0x${"cd".repeat(20)}`);
  });
});

describe("lane emitter descriptor generator input", () => {
  const tempRoots: string[] = [];
  afterAll(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  });

  it("reads bridge route refs and mint pins from the reviewed sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "lane-emitter-"));
    tempRoots.push(root);
    const riskReviewDir = resolve(root, "shared/data/stablecoins/domains/risk-review");
    const mintAuthorityDir = resolve(root, "shared/data/stablecoins/domains/mint-authority");
    mkdirSync(riskReviewDir, { recursive: true });
    mkdirSync(mintAuthorityDir, { recursive: true });
    writeFileSync(resolve(riskReviewDir, "fixture-a.json"), JSON.stringify({
      id: "fixture-a",
      bridgeRouteRisk: {
        controls: [
          {
            id: "fixture-control",
            routeRefs: [ROUTE],
            controllerChain: "ethereum",
            controllerAddress: CONTROLLER,
            executionScope: { pin: { runtimeIdentity: DECODED_IDENTITY } },
          },
          { id: "no-controller", routeRefs: [SECOND_ROUTE] },
        ],
      },
    }));
    writeFileSync(resolve(mintAuthorityDir, "fixture-b.json"), JSON.stringify({
      id: "fixture-b",
      mintAuthority: {
        controls: [{
          label: "minter",
          chain: "base",
          address: OTHER_CONTROLLER,
          weightedQuorum: { pin: { runtimeIdentity: `sha256:${HASH}` } },
        }],
      },
    }));

    const loaded = loadLaneControlRecords(root);
    expect(loaded.sidecars).toEqual({ riskReview: 1, mintAuthority: 1 });
    expect(loaded.records.map((row) => [row.recordKind, row.routeRefs, row.controllerChain, row.runtimeIdentity])).toEqual([
      ["bridge-control", [ROUTE], "ethereum", DECODED_IDENTITY],
      ["bridge-control", [SECOND_ROUTE], null, null],
      ["mint-control", [], "base", `sha256:${HASH}`],
    ]);

    const artifact = buildLaneEmitterDescriptors(root);
    expect(artifact.summary).toMatchObject({ lanes: 2, covered: 1, noReviewedEmitter: 1 });
    expect(artifact.descriptors[0]!.subjectDeploymentKey).toBe(ROUTE);
    expect(artifact.noReviewedEmitter[0]).toMatchObject({ subjectDeploymentKey: SECOND_ROUTE, reason: "missing-runtime-identity" });
  });

  it("reproduces the committed artifact byte for byte with a consistent summary", () => {
    const artifact = buildLaneEmitterDescriptors(ROOT);
    const committed = readFileSync(ARTIFACT_PATH, "utf8");

    expect(`${JSON.stringify(artifact)}\n`).toBe(committed);
    expect(artifact.summary.covered + artifact.summary.noReviewedEmitter).toBe(artifact.summary.lanes);
    expect(Object.values(artifact.summary.noReviewedEmitterByReason).reduce((sum, count) => sum + count, 0))
      .toBe(artifact.summary.noReviewedEmitter);
  });
});
