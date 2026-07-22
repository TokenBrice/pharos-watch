import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildProtocolApiMeasurement,
  ETHENA_PROTOCOL_API_URLS,
  FALCON_TRANSPARENCY_URL,
  isSameProtocolApiSourceSnapshot,
  protocolApiEvidenceFilename,
  ProtocolApiMechanismMeasurementSchema,
  replayProtocolApiMeasurement,
  serializeProtocolApiMeasurement,
  validateProtocolApiArtifactSet,
  type ProtocolApiMechanismMeasurement,
  type RawProtocolApiObservationInput,
} from "../lib/mechanism-measurement/protocol-api";

const CAPTURED_AT = new Date("2026-07-22T20:05:00.000Z");

function raw(sourceId: string, url: string, body: string, headers: Record<string, string> = {}): RawProtocolApiObservationInput {
  return { sourceId, url, rawBody: Buffer.from(body), headers };
}

function usdeInputs(options: { statusTimestamp?: string; porAt?: string; confirmed?: boolean; deltaNeutral?: boolean; backing?: string } = {}) {
  const porAt = options.porAt ?? "2026-07-17T00:06:43.000Z";
  const statusBody = `{"timestamp":"${options.statusTimestamp ?? "2026-07-22 20:00:16.250683 UTC"}","totalBackingAssetsInUsd":${options.backing ?? "4032944678.04"},"totalReserveFundInUsd":62097782.084185585,"totalTokenSupplyInUsd":4028272966.14659}`;
  const porBody = JSON.stringify({
    lastUpdatedAt: porAt,
    reports: [
      {
        auditors: [
          { name: "HarrisAndTrotter", is_confirmed: options.confirmed ?? true },
          { name: "Chainlink", is_confirmed: options.confirmed ?? true },
        ],
        date: porAt,
        deltaNeutral: options.deltaNeutral ?? true,
        overCollateralized: options.deltaNeutral ?? true,
      },
    ],
  });
  return [
    raw("ethena-collateralization-status", ETHENA_PROTOCOL_API_URLS.collateralizationStatus, statusBody),
    raw("ethena-proof-of-reserves", ETHENA_PROTOCOL_API_URLS.proofOfReserves, porBody),
  ];
}

function falconBody(overrides: {
  snapshotDate?: string;
  tvl?: string;
  supply?: string;
  insurance?: string;
  firstCell?: string;
  reserves?: Record<string, Record<string, string>>;
} = {}): string {
  return `{
    "snapshot_date":${overrides.snapshotDate ?? "1784750400"},
    "tvl":"${overrides.tvl ?? "100"}",
    "usdf":{
      "supply":"${overrides.supply ?? "90"}",
      "insurance_fund":"${overrides.insurance ?? "1"}",
      "reserves":${JSON.stringify(overrides.reserves ?? { ceffu: { stablecoins: "105", btc: "0" } })},
      "venues":{},
      "breakdown":{"assets":[
        {"label":"USDC","ceffu":${overrides.firstCell ?? '"60"'},"fireblocks":"20"},
        {"label":"BTC","multisig":"20"}
      ]}
    }
  }`;
}

function falconInput(body = falconBody(), headers: Record<string, string> = {}) {
  return [raw("falcon-transparency", FALCON_TRANSPARENCY_URL, body, headers)];
}

function metric(artifact: ProtocolApiMechanismMeasurement, id: string) {
  return artifact.metrics.find((candidate) => candidate.id === id)!;
}

describe("protocol API Artifact V2", () => {
  it("derives exact USDe metrics from raw numeric tokens and replays byte-identically", () => {
    const body = usdeInputs()[0]!.rawBody;
    const digest = createHash("sha256").update(body).digest("base64");
    const inputs = usdeInputs();
    inputs[0] = { ...inputs[0]!, headers: { "Content-Digest": `sha-256=:${digest}:`, ETag: '"snapshot"' } };
    const artifact = buildProtocolApiMeasurement("usde-ethena", inputs, CAPTURED_AT);

    expect(ProtocolApiMechanismMeasurementSchema.parse(artifact)).toEqual(artifact);
    expect(metric(artifact, "collateralizationRatio")).toMatchObject({
      state: "measured",
      value: "1.001159730717",
      derivation: { numerator: "4032944678.04", denominator: "4028272966.14659", rounding: "half-up", scale: 12 },
    });
    expect(metric(artifact, "reserveExcessPct")).toMatchObject({ state: "measured", value: "0.115973071653" });
    expect(metric(artifact, "dedicatedLossAbsorptionShare")).toMatchObject({ state: "measured", value: "0.015415485149" });
    expect(metric(artifact, "hedgeCoverageRatio")).toMatchObject({ state: "unavailable" });
    expect(artifact.claims).toEqual([
      { id: "deltaNeutral", value: true, observedAt: "2026-07-17T00:06:43.000Z", sourceObservationIds: ["ethena-proof-of-reserves"] },
      { id: "overCollateralized", value: true, observedAt: "2026-07-17T00:06:43.000Z", sourceObservationIds: ["ethena-proof-of-reserves"] },
    ]);
    expect(artifact.observations[0]).toMatchObject({
      contentDigestVerification: "verified",
      headers: { "content-digest": `sha-256=:${digest}:`, etag: '"snapshot"' },
    });
    expect(serializeProtocolApiMeasurement(replayProtocolApiMeasurement(artifact))).toBe(serializeProtocolApiMeasurement(artifact));
    expect(protocolApiEvidenceFilename(artifact)).toMatch(/^2026-07-22T20-00-16\.250Z-[0-9a-f]{12}-protocol-api\.json$/);
  });

  it("records adverse claims without inventing unavailable trading-risk metrics", () => {
    const artifact = buildProtocolApiMeasurement(
      "usde-ethena",
      usdeInputs({ backing: "3900000000", deltaNeutral: false }),
      CAPTURED_AT,
    );

    expect(artifact.claims.map((claim) => claim.value)).toEqual([false, false]);
    expect(metric(artifact, "reserveExcessPct")).toMatchObject({ state: "measured", value: "-3.184316634562" });
    expect(artifact.metrics.filter((candidate) => candidate.state === "unavailable")).toHaveLength(4);
    expect(artifact.adoptionEligibility.status).toBe("blocked");
    expect(artifact.scoreImpactAssessment.expectedEffect).toBe("confirm");
  });

  it("fails closed on stale, future, and unconfirmed Ethena source data", () => {
    expect(() => buildProtocolApiMeasurement("usde-ethena", usdeInputs({ statusTimestamp: "2026-07-21 01:00:00 UTC" }), CAPTURED_AT)).toThrow(/status is stale/);
    expect(() => buildProtocolApiMeasurement("usde-ethena", usdeInputs({ statusTimestamp: "2026-07-22 20:11:00 UTC" }), CAPTURED_AT)).toThrow(/future/);
    expect(() => buildProtocolApiMeasurement("usde-ethena", usdeInputs({ porAt: "2026-07-01T00:00:00.000Z" }), CAPTURED_AT)).toThrow(/proof of reserves is stale/);
    expect(() => buildProtocolApiMeasurement("usde-ethena", usdeInputs({ confirmed: false }), CAPTURED_AT)).toThrow(/no confirmed auditor/);
  });

  it("binds both observations into identity and rejects raw-byte tampering and same-time conflicts", () => {
    const first = buildProtocolApiMeasurement("usde-ethena", usdeInputs(), CAPTURED_AT);
    const changedPor = buildProtocolApiMeasurement("usde-ethena", usdeInputs({ deltaNeutral: false }), CAPTURED_AT);
    expect(changedPor.observations[0]!.observationHash).toBe(first.observations[0]!.observationHash);
    expect(changedPor.snapshotId).not.toBe(first.snapshotId);
    expect(() => validateProtocolApiArtifactSet([first, changedPor])).toThrow(/same observation-time vector/);

    const tampered = structuredClone(first);
    tampered.observations[0]!.rawBodyBase64 = Buffer.from("{}").toString("base64");
    expect(() => replayProtocolApiMeasurement(tampered)).toThrow(/raw-body hash mismatch/);

    const tamperedSnapshotId = structuredClone(first);
    tamperedSnapshotId.snapshotId = "0".repeat(64);
    expect(() => ProtocolApiMechanismMeasurementSchema.parse(tamperedSnapshotId)).toThrow(/snapshot ID mismatch/);

    const unknownSource = structuredClone(first);
    unknownSource.metrics[0]!.sourceObservationIds = ["not-a-recorded-source"];
    expect(() => ProtocolApiMechanismMeasurementSchema.parse(unknownSource)).toThrow(/unknown source observation ID/);

    const retry = buildProtocolApiMeasurement("usde-ethena", usdeInputs(), new Date("2026-07-22T20:06:00.000Z"));
    expect(retry.snapshotId).toBe(first.snapshotId);
    expect(retry.capturedAt).not.toBe(first.capturedAt);

    const rotatedTransport = usdeInputs();
    rotatedTransport[0] = { ...rotatedTransport[0]!, headers: { ETag: '"rotated"' } };
    const rotatedRetry = buildProtocolApiMeasurement(
      "usde-ethena",
      rotatedTransport,
      new Date("2026-07-22T20:06:00.000Z"),
    );
    expect(isSameProtocolApiSourceSnapshot(first, rotatedRetry)).toBe(true);
    expect(first.capturedAt).toBe(CAPTURED_AT.toISOString());
    expect(first.observations[0]!.headers).toEqual({});
  });

  it("normalizes source exponent notation without floating-point coercion", () => {
    const inputs = usdeInputs();
    inputs[0] = raw(
      "ethena-collateralization-status",
      ETHENA_PROTOCOL_API_URLS.collateralizationStatus,
      '{"timestamp":"2026-07-22 20:00:16 UTC","totalBackingAssetsInUsd":1.01e2,"totalReserveFundInUsd":1e0,"totalTokenSupplyInUsd":1e2}',
    );
    const artifact = buildProtocolApiMeasurement("usde-ethena", inputs, CAPTURED_AT);
    expect(metric(artifact, "collateralizationRatio")).toMatchObject({ value: "1.01" });
    expect(artifact.observations[0]!.parsedPayload).toMatchObject({ totalBackingAssetsInUsd: "101" });
  });

  it("rejects malformed monetary tokens and required-field schema drift", () => {
    const malformed = usdeInputs();
    malformed[0] = raw(
      "ethena-collateralization-status",
      ETHENA_PROTOCOL_API_URLS.collateralizationStatus,
      '{"timestamp":"2026-07-22 20:00:16 UTC","totalBackingAssetsInUsd":"101","totalReserveFundInUsd":1,"totalTokenSupplyInUsd":100}',
    );
    expect(() => buildProtocolApiMeasurement("usde-ethena", malformed, CAPTURED_AT)).toThrow();

    const drifted = usdeInputs();
    drifted[0] = raw(
      "ethena-collateralization-status",
      ETHENA_PROTOCOL_API_URLS.collateralizationStatus,
      '{"timestamp":"2026-07-22 20:00:16 UTC","totalBackingAssetsInUsd":101,"totalReserveFundInUsd":1}',
    );
    expect(() => buildProtocolApiMeasurement("usde-ethena", drifted, CAPTURED_AT)).toThrow();
  });
});

describe("Falcon transparency target", () => {
  it("accepts and exactly normalizes the live mix of quoted and numeric-token asset cells", () => {
    const artifact = buildProtocolApiMeasurement(
      "usdf-falcon",
      falconInput(falconBody({ firstCell: "60" })),
      CAPTURED_AT,
    );
    expect(artifact.snapshotObservedAt).toBe("2026-07-22T20:00:00.000Z");
    expect(metric(artifact, "collateralizationRatio")).toMatchObject({ state: "measured", value: "1.111111111111" });
    expect(metric(artifact, "reserveExcessPct")).toMatchObject({ state: "measured", value: "11.111111111111" });
    expect(metric(artifact, "dedicatedLossAbsorptionShare")).toMatchObject({ state: "measured", value: "0.011111111111" });
    expect(artifact.breakdowns[0]!.entries).toEqual([
      {
        key: "BTC",
        amountUsd: "20",
        share: "0.2",
        shareDerivation: { formulaId: "allocation-share", numerator: "20", denominator: "100", rounding: "half-up", scale: 12 },
      },
      {
        key: "USDC",
        amountUsd: "80",
        share: "0.8",
        shareDerivation: { formulaId: "allocation-share", numerator: "80", denominator: "100", rounding: "half-up", scale: 12 },
      },
    ]);
    expect(artifact.breakdowns[1]!.entries.map(({ key, amountUsd, share }) => ({ key, amountUsd, share }))).toEqual([
      { key: "ceffu", amountUsd: "60", share: "0.6" },
      { key: "fireblocks", amountUsd: "20", share: "0.2" },
      { key: "multisig", amountUsd: "20", share: "0.2" },
    ]);
    expect(artifact.reconciliations.map((entry) => entry.status)).toEqual(["pass", "unresolved", "unresolved"]);
    expect(artifact.metrics.filter((candidate) => candidate.state === "unavailable")).toHaveLength(4);
    expect(artifact.scoreImpactAssessment.expectedEffect).toBe("indeterminate");

    expect(artifact.observations[0]!.parsedPayload).toMatchObject({ snapshot_date: "1784750400" });
    const parsedPayload = artifact.observations[0]!.parsedPayload as {
      usdf: { breakdown: { assets: Array<Record<string, string>> } };
    };
    expect(parsedPayload.usdf.breakdown.assets[0]).toEqual({ label: "USDC", ceffu: "60", fireblocks: "20" });
  });

  it.each(["false", "null", '"not-a-decimal"', "-1", '"-1"'])(
    "rejects invalid or negative Falcon asset cell %s",
    (firstCell) => {
      expect(() =>
        buildProtocolApiMeasurement("usdf-falcon", falconInput(falconBody({ firstCell })), CAPTURED_AT),
      ).toThrow(/not a decimal|negative/);
    },
  );

  it("fails closed when asset rows drift from TVL or required Falcon objects disappear", () => {
    expect(() => buildProtocolApiMeasurement("usdf-falcon", falconInput(falconBody({ tvl: "101" })), CAPTURED_AT)).toThrow(/do not reconcile/);
    const missingVenues = falconBody().replace('"venues":{},', "");
    expect(() => buildProtocolApiMeasurement("usdf-falcon", falconInput(missingVenues), CAPTURED_AT)).toThrow();
    expect(() => buildProtocolApiMeasurement("usdf-falcon", falconInput(falconBody({ snapshotDate: "1784751060" })), CAPTURED_AT)).toThrow(/future/);
  });

  it("keeps published reserves and insurance outside reconciled backing", () => {
    const artifact = buildProtocolApiMeasurement(
      "usdf-falcon",
      falconInput(falconBody({ insurance: "10", reserves: { ceffu: { stablecoins: "104.956", btc: "0" } } })),
      CAPTURED_AT,
    );
    expect(metric(artifact, "collateralizationRatio")).toMatchObject({ value: "1.111111111111", derivation: { numerator: "100" } });
    expect(metric(artifact, "dedicatedLossAbsorptionShare")).toMatchObject({ value: "0.111111111111", derivation: { numerator: "10" } });
    expect(artifact.reconciliations[1]).toMatchObject({ status: "unresolved", left: "104.956", right: "100" });
    expect(artifact.reconciliations[1]!.relativeDeltaDerivation).toMatchObject({
      numerator: "4.956",
      denominator: "100",
      rounding: "half-up",
      scale: 12,
    });
    expect(metric(artifact, "executableUnwindCapacityUsd")).toMatchObject({ state: "unavailable" });
  });

  it("preserves high precision and covers undercollateralization, freshness, and repeated snapshots", () => {
    const highPrecision = buildProtocolApiMeasurement(
      "usdf-falcon",
      falconInput(falconBody({ tvl: "100.000000000000000001", firstCell: "60.000000000000000001" })),
      CAPTURED_AT,
    );
    expect(highPrecision.breakdowns[0]!.entries.find((entry) => entry.key === "USDC")?.amountUsd).toBe(
      "80.000000000000000001",
    );

    const undercollateralized = buildProtocolApiMeasurement(
      "usdf-falcon",
      falconInput(falconBody({ supply: "110" })),
      CAPTURED_AT,
    );
    expect(metric(undercollateralized, "reserveExcessPct")).toMatchObject({ value: "-9.090909090909" });
    expect(() =>
      buildProtocolApiMeasurement(
        "usdf-falcon",
        falconInput(falconBody({ snapshotDate: "1784500000" })),
        CAPTURED_AT,
      ),
    ).toThrow(/stale/);

    const retry = buildProtocolApiMeasurement(
      "usdf-falcon",
      falconInput(),
      new Date("2026-07-22T20:06:00.000Z"),
    );
    const first = buildProtocolApiMeasurement("usdf-falcon", falconInput(), CAPTURED_AT);
    expect(retry.snapshotId).toBe(first.snapshotId);
    expect(() => validateProtocolApiArtifactSet([first, retry])).toThrow(/Duplicate protocol API snapshot ID/);
  });

  it("enforces the Falcon TVL reconciliation tolerance boundary", () => {
    expect(() =>
      buildProtocolApiMeasurement("usdf-falcon", falconInput(falconBody({ tvl: "100.01" })), CAPTURED_AT),
    ).not.toThrow();
    expect(() =>
      buildProtocolApiMeasurement("usdf-falcon", falconInput(falconBody({ tvl: "100.0100000001" })), CAPTURED_AT),
    ).toThrow(/do not reconcile/);

    expect(() =>
      buildProtocolApiMeasurement(
        "usdf-falcon",
        falconInput(falconBody({ tvl: "20000000.02", firstCell: "19999960" })),
        CAPTURED_AT,
      ),
    ).not.toThrow();
    expect(() =>
      buildProtocolApiMeasurement(
        "usdf-falcon",
        falconInput(falconBody({ tvl: "20000000.020000001", firstCell: "19999960" })),
        CAPTURED_AT,
      ),
    ).toThrow(/do not reconcile/);
  });
});

describe("protocol API CLI policy", () => {
  const script = "scripts/maintenance/measure-protocol-api-mechanism-metrics.ts";

  it.each([
    [["--asset", "unknown"], /unknown --asset/],
    [["--asset", "usde-ethena", "--asset", "usde-ethena"], /must not be duplicated/],
    [["--replay-all", "--asset", "usde-ethena"], /exclusive/],
    [["--asset", "usde-ethena", "--asset", "usdf-falcon", "--replay", "missing.json"], /exclusive/],
    [["--replay", "one.json", "--replay", "two.json", "--asset", "usde-ethena"], /exclusive/],
    [[], /requires at least one --asset/],
  ] as const)("rejects invalid arguments before I/O: %j", (args, expected) => {
    const result = spawnSync("npx", ["tsx", script, ...args], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(expected);
  });

  it("accepts repeated canonical replays, sorts full time vectors newest first, and rejects noncanonical bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-protocol-api-test-"));
    try {
      const older = buildProtocolApiMeasurement("usde-ethena", usdeInputs(), CAPTURED_AT);
      const newer = buildProtocolApiMeasurement(
        "usde-ethena",
        usdeInputs({ statusTimestamp: "2026-07-22 20:01:16.250683 UTC" }),
        CAPTURED_AT,
      );
      expect(validateProtocolApiArtifactSet([older, newer]).map((artifact) => artifact.snapshotId)).toEqual([
        newer.snapshotId,
        older.snapshotId,
      ]);

      const olderPath = join(directory, "older.json");
      const newerPath = join(directory, "newer.json");
      writeFileSync(olderPath, serializeProtocolApiMeasurement(older));
      writeFileSync(newerPath, serializeProtocolApiMeasurement(newer));
      const repeated = spawnSync("npx", ["tsx", script, "--replay", olderPath, "--replay", newerPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(repeated.status).toBe(0);

      const noncanonicalPath = join(directory, "noncanonical.json");
      writeFileSync(noncanonicalPath, JSON.stringify(older, null, 2));
      const noncanonical = spawnSync("npx", ["tsx", script, "--replay", noncanonicalPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(noncanonical.status).toBe(1);
      expect(noncanonical.stderr).toMatch(/not canonical/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the frozen committed V1 artifact as normalized-only legacy evidence", () => {
    const legacyPath =
      "shared/data/safety-score-v9/mechanism-measurements/usde-ethena/2026-07-22T20-00-16.250Z-protocol-api.json";
    const result = spawnSync("npx", ["tsx", script, "--replay", legacyPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/frozen legacy V1 fingerprint passed/);
    expect(result.stdout).toMatch(/raw replay unavailable/);

    const directory = mkdtempSync(join(tmpdir(), "pharos-legacy-protocol-api-test-"));
    try {
      const copiedPath = join(directory, "copied-protocol-api.json");
      writeFileSync(copiedPath, readFileSync(legacyPath));
      const copied = spawnSync("npx", ["tsx", script, "--replay", copiedPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(copied.status).toBe(1);
      expect(copied.stderr).toMatch(/Unknown or modified legacy protocol API artifact/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
