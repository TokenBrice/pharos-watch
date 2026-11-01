import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveLaneEmitterDescriptors,
  LANE_EMITTER_MINIMUM_LOOKBACK_BLOCKS,
  loadLaneScreeningEmitterInventory,
  type LaneControlRecord,
  type LaneEmitterDescriptorsArtifact,
  type LaneEmitterInputs,
  type LaneScreeningEmitterInventory,
} from "../build-data/generate-safety-score-v9-lane-emitter-descriptors";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ARTIFACT_PATH = resolve(ROOT, "shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json");

const HASH = "a".repeat(64);
const SUBJECT = "ethereum:0x1111111111111111111111111111111111111111";
const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";

function bridgeControl(overrides: Partial<LaneControlRecord> = {}): LaneControlRecord {
  return {
    recordKind: "bridge-control",
    assetId: "fixture-asset",
    controlId: "fixture-control",
    routeRefs: [SUBJECT],
    controllerChain: "ethereum",
    controllerAddress: POOL,
    runtimeIdentity: null,
    ...overrides,
  };
}

function emitter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: TOKEN,
    chain: "ethereum",
    role: "route-deployment",
    label: "Fixture token",
    runtimeIdentity: `sha256-decoded-runtime-bytes:${HASH}`,
    observedBlock: 1_000,
    observedAt: "2026-10-30T07:12:47Z",
    abiBasis: {
      kind: "verified-source",
      chain: "ethereum",
      address: TOKEN,
      runtimeIdentity: `sha256-decoded-runtime-bytes:${HASH}`,
      verifiedSourceUrl: "https://etherscan.io/address/0x1111111111111111111111111111111111111111#code",
    },
    adminEvents: ["OwnershipTransferred", "Upgraded"],
    sources: [{ label: "fixture", url: "https://etherscan.io/address/0x1111111111111111111111111111111111111111#code" }],
    ...overrides,
  };
}

function inventory(lanes: readonly Record<string, unknown>[] = [{
  subjectDeploymentKey: SUBJECT,
  assetIds: ["fixture-asset"],
  rail: "chainlink-ccip",
  contributors: [{ controlId: "fixture-control", emitterAddresses: [TOKEN] }],
  emitters: [emitter()],
}]): LaneScreeningEmitterInventory {
  return {
    schemaVersion: 1,
    reviewedAt: "2026-10-30",
    policy: {},
    lookbackBlocksByChain: { ethereum: LANE_EMITTER_MINIMUM_LOOKBACK_BLOCKS },
    lanes: lanes as unknown as LaneScreeningEmitterInventory["lanes"],
  };
}

function derive(overrides: {
  records?: readonly LaneControlRecord[];
  inventory?: LaneScreeningEmitterInventory;
} = {}) {
  const input: LaneEmitterInputs = {
    records: overrides.records ?? [bridgeControl()],
    sidecars: { riskReview: 1, mintAuthority: 0 },
    inventory: overrides.inventory ?? inventory(),
  };
  return deriveLaneEmitterDescriptors(input);
}

describe("lane emitter descriptor admission", () => {
  it("admits a lane whose inventory maps every contributor to a pinned, ABI-covered emitter", () => {
    const artifact = derive();
    expect(artifact.summary.covered).toBe(1);
    expect(artifact.descriptors).toHaveLength(1);
    const descriptor = artifact.descriptors[0]!;
    expect(descriptor.subjectDeploymentKey).toBe(SUBJECT);
    expect(descriptor.emitters).toEqual([{
      address: TOKEN,
      expectedRuntimeCodeSha256: HASH,
      families: ["OwnershipTransferred", "Upgraded"],
    }]);
    expect(descriptor.lookbackBlocks).toBe(LANE_EMITTER_MINIMUM_LOOKBACK_BLOCKS);
    expect(descriptor.provenance.controlIds).toEqual(["fixture-control"]);
    expect(descriptor.provenance.contributors).toEqual([{ controlId: "fixture-control", emitterAddresses: [TOKEN] }]);
    expect(descriptor.provenance.emitters[0]).toMatchObject({ address: TOKEN, role: "route-deployment" });
    expect(descriptor.provenance.reviewedAt).toBe("2026-10-30");
  });

  it("keeps every reviewed lane without an inventory record closed", () => {
    const artifact = derive({ inventory: inventory([]) });
    expect(artifact.summary.covered).toBe(0);
    expect(artifact.noReviewedEmitter).toEqual([{
      subjectDeploymentKey: SUBJECT,
      reason: "no-reviewed-inventory",
      assetIds: ["fixture-asset"],
      controlIds: ["fixture-control"],
    }]);
  });

  it("closes a lane whose emitter ABI has an admin event outside the frozen vocabulary", () => {
    const artifact = derive({
      inventory: inventory([{
        subjectDeploymentKey: SUBJECT,
        assetIds: ["fixture-asset"],
        rail: "chainlink-ccip",
        contributors: [{ controlId: "fixture-control", emitterAddresses: [TOKEN] }],
        emitters: [emitter({ adminEvents: ["OwnershipTransferred", "UnreviewedAdminEvent"] })],
      }]),
    });
    expect(artifact.summary.covered).toBe(0);
    expect(artifact.noReviewedEmitter[0]).toMatchObject({
      reason: "abi-not-covered",
      uncoveredEvents: ["UnreviewedAdminEvent"],
    });
    expect(artifact.summary.inventory.uncoveredEvents).toEqual(["UnreviewedAdminEvent"]);
  });

  it("closes a lane when a reviewed contributor has no mapped emitter", () => {
    const artifact = derive({
      records: [bridgeControl(), bridgeControl({ controlId: "second-control", routeRefs: [SUBJECT] })],
      inventory: inventory([{
        subjectDeploymentKey: SUBJECT,
        assetIds: ["fixture-asset"],
        rail: "chainlink-ccip",
        contributors: [
          { controlId: "fixture-control", emitterAddresses: [TOKEN] },
          { controlId: "second-control", emitterAddresses: ["0x3333333333333333333333333333333333333333"] },
        ],
        emitters: [emitter()],
      }]),
    });
    expect(artifact.noReviewedEmitter[0]).toMatchObject({
      reason: "contributor-without-emitter",
      unpinnedControlIds: ["second-control"],
    });
  });

  it("closes a lane whose contributor set disagrees with the reviewed controls", () => {
    const artifact = derive({
      inventory: inventory([{
        subjectDeploymentKey: SUBJECT,
        assetIds: ["fixture-asset"],
        rail: "chainlink-ccip",
        contributors: [{ controlId: "unreviewed-control", emitterAddresses: [TOKEN] }],
        emitters: [emitter()],
      }]),
    });
    expect(artifact.noReviewedEmitter[0]).toMatchObject({
      reason: "contributor-mismatch",
      unpinnedControlIds: ["fixture-control"],
    });
  });

  it("refuses an emitter pin outside the decoded-runtime domain", () => {
    const artifact = derive({
      inventory: inventory([{
        subjectDeploymentKey: SUBJECT,
        assetIds: ["fixture-asset"],
        rail: "chainlink-ccip",
        contributors: [{ controlId: "fixture-control", emitterAddresses: [TOKEN] }],
        emitters: [emitter({ runtimeIdentity: `sha256:${HASH}` })],
      }]),
    });
    expect(artifact.noReviewedEmitter[0]?.reason).toBe("emitter-pin-not-decoded");
  });

  it("refuses a lane whose per-chain lookback is below the 50,000-block floor", () => {
    const artifact = derive({
      inventory: {
        ...inventory(),
        lookbackBlocksByChain: { ethereum: LANE_EMITTER_MINIMUM_LOOKBACK_BLOCKS - 1 },
      },
    });
    expect(artifact.noReviewedEmitter[0]?.reason).toBe("lookback-below-floor");
  });

  it("deduplicates and validates emitters per lane", () => {
    const artifact = derive({
      inventory: inventory([{
        subjectDeploymentKey: SUBJECT,
        assetIds: ["fixture-asset"],
        rail: "chainlink-ccip",
        contributors: [{ controlId: "fixture-control", emitterAddresses: [TOKEN] }],
        emitters: [emitter(), emitter({ address: TOKEN.toUpperCase().replace("0X", "0x") as `0x${string}` })],
      }]),
    });
    expect(artifact.noReviewedEmitter[0]?.reason).toBe("invalid-inventory-lane");
  });

  it("rejects a chain mismatch between the lane and an emitter", () => {
    const artifact = derive({
      inventory: inventory([{
        subjectDeploymentKey: SUBJECT,
        assetIds: ["fixture-asset"],
        rail: "chainlink-ccip",
        contributors: [{ controlId: "fixture-control", emitterAddresses: [TOKEN] }],
        emitters: [emitter({ chain: "arbitrum" })],
      }]),
    });
    expect(artifact.noReviewedEmitter[0]?.reason).toBe("invalid-inventory-lane");
  });

  it("reproduces the same bytes for the same input", () => {
    const first = JSON.stringify(derive());
    const second = JSON.stringify(derive());
    expect(second).toBe(first);
  });
});

describe("lane screening emitter inventory loader", () => {
  it("loads the reviewed pilot inventory", () => {
    const loaded = loadLaneScreeningEmitterInventory(ROOT);
    expect(loaded.reviewedAt).toBe("2026-10-30");
    expect(loaded.lanes).toHaveLength(5);
    expect(loaded.lanes.flatMap((lane) => lane.emitters)).toHaveLength(11);
    for (const lane of loaded.lanes) {
      for (const record of lane.contributors) {
        expect(record.emitterAddresses.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the committed descriptor artifact in step with the reviewed inventory", () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as LaneEmitterDescriptorsArtifact;
    expect(artifact.summary.lanes).toBe(543);
    expect(artifact.summary.inventory.pilotLanes).toBe(5);
    expect(artifact.pilot).toHaveLength(5);
    expect(artifact.summary.covered).toBe(5);
    expect(artifact.pilot.every((lane) => lane.admission.admitted)).toBe(true);
    expect(artifact.summary.inventory.uncoveredEvents).toEqual([]);
  });

  it("regenerates the committed artifact deterministically", () => {
    const output = execFileSync("node", ["--import", "tsx", resolve(ROOT, "scripts/build-data/generate-safety-score-v9-lane-emitter-descriptors.ts"), "--check"], { encoding: "utf8" });
    expect(output).toContain("current");
  });
});
