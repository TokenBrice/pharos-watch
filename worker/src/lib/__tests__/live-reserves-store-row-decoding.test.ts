import { describe, expect, it } from "vitest";
import {
  MALFORMED_REDEMPTION_TELEMETRY,
  parseReserveCompositionRow,
  parseSnapshotMetadata,
} from "../live-reserves/store-row-decoding";

function row(slices: unknown[]) {
  return {
    stablecoin_id: "iusd-infinifi",
    slices: JSON.stringify(slices),
    fetched_at: 1_700_000_000,
    source: "infinifi",
    metadata: "{}",
    warnings: null as string | null,
    warning_count: 0 as number | null,
    adapter_source_model: "dynamic-mix" as string | null,
    adapter_evidence_class: "independent" as string | null,
  };
}

describe("stored live reserve dependency validation", () => {
  it.each([
    ["self target", [{ name: "Self", pct: 100, risk: "low", coinId: "iusd-infinifi" }]],
    ["unknown target", [{ name: "Unknown", pct: 100, risk: "low", coinId: "not-tracked" }]],
    ["depType without target", [{ name: "Missing", pct: 100, risk: "low", depType: "mechanism" }]],
  ])("rejects %s on D1 read", (_label, slices) => {
    expect(parseReserveCompositionRow(row(slices), null)).toEqual({
      record: null,
      issue: {
        code: "invalid-slice",
        message: "stored reserve snapshot contains invalid slice entries",
      },
    });
  });

  it("accepts a known tracked dependency target", () => {
    const parsed = parseReserveCompositionRow(
      row([{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral" }]),
      null,
    );
    expect(parsed.issue).toBeNull();
    expect(parsed.record?.slices[0]).toMatchObject({ coinId: "usdc-circle", depType: "collateral" });
  });
});

describe("stored live reserve slice integrity", () => {
  it.each([
    ["invalid-json", "{not json"],
    ["invalid-payload", JSON.stringify({ name: "obj" })],
    ["empty-slices", "[]"],
    ["invalid-sum", JSON.stringify([{ name: "Cash", pct: 60, risk: "low" }])],
  ])("reports %s instead of returning a partial record", (code, slices) => {
    const parsed = parseReserveCompositionRow({ ...row([]), slices }, null);
    expect(parsed.record).toBeNull();
    expect(parsed.issue?.code).toBe(code);
  });

  it("falls back to the adapter definition for source model and evidence class, failing closed on unknown adapters", () => {
    const stored = { ...row([{ name: "Cash", pct: 100, risk: "low" }]), adapter_source_model: null, adapter_evidence_class: "nope" };
    const parsed = parseReserveCompositionRow(stored, null);
    expect(parsed.issue).toBeNull();
    expect(parsed.record).toMatchObject({ adapterSourceModel: expect.any(String), adapterEvidenceClass: expect.any(String) });

    const unknown = { ...stored, stablecoin_id: "not-tracked", source: "no-such-adapter" };
    expect(parseReserveCompositionRow(unknown, null).issue?.code).toBe("unknown-adapter-source");
  });

  it("decodes warnings with severity and effect defaults and drops malformed entries", () => {
    const parsed = parseReserveCompositionRow(
      { ...row([{ name: "Cash", pct: 100, risk: "low" }]), warnings: JSON.stringify([
        { code: "stale", message: "source lagging", effect: "fatal" },
        { code: "note", message: "fyi", severity: "info" },
        { code: "missing-message" },
        "not an object",
      ]), warning_count: null },
      null,
    );
    expect(parsed.record?.warnings).toEqual([
      { code: "stale", message: "source lagging", severity: "warning", effect: "fatal" },
      { code: "note", message: "fyi", severity: "info", effect: "info" },
    ]);
    expect(parsed.record?.warningCount).toBe(2);
  });
});

describe("stored live reserve snapshot metadata normalization", () => {
  it("keeps only vocabulary-valid redemption fields and flags malformed telemetry", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "verified",
      details: { note: "kept" },
      redemption: {
        capacityUsd: 1_000,
        capacityRatioOfSupply: "0.5",
        feeBps: Number.NaN,
        capacityKind: "live-direct",
        freshnessKind: "not-a-kind",
        routeStatus: "open",
        routeStatusSource: "static-config",
        routeStatusReason: "reviewed",
        routeStatusReviewedAt: 42,
        holderEligibility: "verified-customer",
        sourceUrls: [
          "https://issuer.example/redeem",
          "https://issuer.example/redeem",
          "ftp://issuer.example/ignored",
          "not a url",
          7,
        ],
      },
    }));

    expect(metadata.freshnessMode).toBe("verified");
    expect(metadata.details).toEqual({ note: "kept" });
    expect(metadata.redemption).toMatchObject({
      capacityUsd: 1_000,
      capacityKind: "live-direct",
      routeStatus: "open",
      routeStatusSource: "static-config",
      routeStatusReason: "reviewed",
      holderEligibility: "verified-customer",
      sourceUrls: ["https://issuer.example/redeem"],
    });
    expect(Object.keys(metadata.redemption ?? {}).sort()).toEqual([
      "capacityKind", "capacityUsd", "holderEligibility", "routeStatus", "routeStatusReason", "routeStatusSource", "sourceUrls",
    ]);
    // Non-numeric telemetry for a known number key is a producer bug, not
    // silently-missing data.
    expect((metadata.redemption as Record<PropertyKey, unknown>)[MALFORMED_REDEMPTION_TELEMETRY]).toBe(true);
  });

  it("treats a non-object redemption block as malformed and drops invalid top-level fields", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "bogus",
      details: ["not", "an", "object"],
      redemption: "bad",
    }));

    expect(metadata.freshnessMode).toBeUndefined();
    expect(metadata.details).toBeUndefined();
    expect(Object.keys(metadata.redemption ?? {})).toEqual([]);
    expect((metadata.redemption as Record<PropertyKey, unknown>)[MALFORMED_REDEMPTION_TELEMETRY]).toBe(true);

    const clean = parseSnapshotMetadata(JSON.stringify({ capacityUsd: 5 }));
    expect(clean.redemption).toBeUndefined();
    // Malformed JSON cannot establish freshness, so it is flagged as
    // invalid-freshness rather than silently dropped.
    expect(parseSnapshotMetadata("not json")).toEqual({ diag: { invalidFreshness: true } });
  });

  it("maps legacy flat capacity and fee fields into the nested redemption shape at decode time", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      immediateRedeemableRatio: 0.25,
      redemptionFeeBps: 50,
    }));

    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.immediateRedeemableRatio).toBeUndefined();
    expect(metadata.redemptionFeeBps).toBeUndefined();
    expect(metadata.redemption).toEqual({
      capacityUsd: 500_000,
      capacityRatioOfSupply: 0.25,
      feeBps: 50,
    });
  });

  it("lets a nested redemption block win over legacy flat fields", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      redemptionFeeBps: 50,
      redemption: {
        capacityUsd: 750_000,
        capacityKind: "live-direct-bounded",
        feeBps: 42,
      },
    }));

    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.redemptionFeeBps).toBeUndefined();
    expect(metadata.redemption).toMatchObject({
      capacityUsd: 750_000,
      capacityKind: "live-direct-bounded",
      feeBps: 42,
    });
  });

  it("drops malformed legacy flat fields without fabricating nested telemetry", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: "not-a-number",
      immediateRedeemableRatio: Number.NaN,
      redemptionFeeBps: "not-a-fee",
    }));

    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.immediateRedeemableRatio).toBeUndefined();
    expect(metadata.redemptionFeeBps).toBeUndefined();
    expect(metadata.redemption).toBeUndefined();
  });

  it("decodes a legacy snapshot missing freshnessMode as the adapter default and tags it", () => {
    const parsed = parseReserveCompositionRow(
      {
        ...row([{ name: "Cash", pct: 100, risk: "low" }]),
        metadata: JSON.stringify({ sourceTimestamp: 1_699_999_000 }),
      },
      null,
    );

    expect(parsed.issue).toBeNull();
    expect(parsed.record?.metadata.freshnessMode).toBe("verified");
    expect(parsed.record?.metadata.diag).toEqual({ freshnessModeLegacyDefault: true });

    // A row that still carries an explicit mode is unaffected by the default.
    const explicit = parseReserveCompositionRow(
      {
        ...row([{ name: "Cash", pct: 100, risk: "low" }]),
        metadata: JSON.stringify({ freshnessMode: "unverified", sourceTimestamp: 1_699_999_000 }),
      },
      null,
    );
    expect(explicit.record?.metadata.freshnessMode).toBe("unverified");
    expect(explicit.record?.metadata.diag).toBeUndefined();
  });
});
