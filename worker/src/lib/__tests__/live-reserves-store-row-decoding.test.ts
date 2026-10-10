import { describe, expect, it } from "vitest";
import {
  parseReserveCompositionRow,
  parseSnapshotMetadata,
} from "../live-reserves/store-row-decoding";
import {
  decodeLiveReserveRedemptionTelemetry,
  LIVE_RESERVE_SOURCE_MODEL_VALUES,
  LIVE_RESERVE_EVIDENCE_CLASS_VALUES,
  LIVE_RESERVE_WARNING_EFFECT_VALUES,
  LIVE_RESERVE_FRESHNESS_MODE_VALUES,
  LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES,
  LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES,
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES,
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES,
} from "@shared/types/live-reserves";

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

  it("decodes supported legacy warning severity and effect defaults without dropping members", () => {
    const parsed = parseReserveCompositionRow(
      { ...row([{ name: "Cash", pct: 100, risk: "low" }]), warnings: JSON.stringify([
        { code: "stale", message: "source lagging", effect: "fatal" },
        { code: "note", message: "fyi", severity: "info" },
      ]), warning_count: null },
      null,
    );
    expect(parsed.record?.warnings).toEqual([
      { code: "stale", message: "source lagging", severity: "warning", effect: "fatal" },
      { code: "note", message: "fyi", severity: "info", effect: "info" },
    ]);
    expect(parsed.record?.warningCount).toBe(2);
  });

  it.each([
    ["not-json", 1], ["{}", 0], ["null", 0], ['[{"code":"material-unknown-exposure","effect":"degraded"}]', 1],
    ['[{"code":"gap","message":"gap","effect":"bogus"}]', 1], ["[]", 1],
    ['[{"code":"gap","message":"gap"}]', 0],
  ])("rejects warning corruption %s with a named integrity reason", (warnings, warning_count) => {
    const parsed = parseReserveCompositionRow({ ...row([{ name: "Cash", pct: 100, risk: "low" }]), warnings, warning_count }, null);
    expect(parsed.record).toBeNull();
    expect(parsed.issue?.code).toBe("invalid-warnings");
  });

  it.each([null, "[]"])("accepts legitimate empty warnings %s", (warnings) => {
    expect(parseReserveCompositionRow({ ...row([{ name: "Cash", pct: 100, risk: "low" }]), warnings }, null).issue).toBeNull();
  });
});

describe("stored live reserve snapshot metadata normalization", () => {
  it("quarantines the whole malformed telemetry claim rather than salvaging positive capacity", () => {
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
    expect(metadata.redemption?.capacityUsd).toBeUndefined();
    expect(Object.keys(metadata.redemption ?? {})).toEqual([]);
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");
    const reloaded = JSON.parse(JSON.stringify(metadata));
    expect(reloaded.redemption.capacityUsd).toBeUndefined();
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
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");

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

  it("treats null legacy fields as unavailable while retaining valid legacy measured zero", () => {
    const absent = parseSnapshotMetadata(JSON.stringify({
      immediateRedeemableUsd: null, immediateRedeemableRatio: null, redemptionFeeBps: null,
    }));
    expect(decodeLiveReserveRedemptionTelemetry(absent).status).toBe("absent");
    expect(absent.redemption).toBeUndefined();
    const measured = parseSnapshotMetadata(JSON.stringify({
      immediateRedeemableUsd: 0, immediateRedeemableRatio: null, redemptionFeeBps: null,
    }));
    expect(decodeLiveReserveRedemptionTelemetry(measured)).toEqual({ status: "valid", telemetry: { capacityUsd: 0 } });
  });

  it("does not rewrite retained valid source URLs on decode", () => {
    const sourceUrls = ["https://issuer.example", "https://issuer.example/", "https://issuer.example"];
    const metadata = parseSnapshotMetadata(JSON.stringify({ redemption: { capacityUsd: 100, sourceUrls } }));
    expect(metadata.redemption?.sourceUrls).toEqual(sourceUrls);
    expect(JSON.parse(JSON.stringify(metadata)).redemption.sourceUrls).toEqual(sourceUrls);
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

  it("quarantines malformed legacy flat fields without fabricating usable telemetry", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: "not-a-number",
      immediateRedeemableRatio: Number.NaN,
      redemptionFeeBps: "not-a-fee",
    }));

    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.immediateRedeemableRatio).toBeUndefined();
    expect(metadata.redemptionFeeBps).toBeUndefined();
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");
  });

  it.each([null, "0", -1])("preserves invalid supplied raw deviation %s but rejects the scoring row", (rawSumDeviation) => {
    const stored = { ...row([{ name: "Cash", pct: 100, risk: "low" }]),
      metadata: JSON.stringify({ diag: { rawSumDeviation, sourceDetail: "retained" } }) };
    expect(parseSnapshotMetadata(stored.metadata).diag).toEqual({ rawSumDeviation, sourceDetail: "retained" });
    const decoded = parseReserveCompositionRow(stored, null);
    expect(decoded.record).toBeNull();
    expect(decoded.issue?.code).toBe("invalid-payload");
  });

  it("preserves zero, extensions, and invalid nested precedence over a valid legacy claim", () => {
    const v9RouteAttempt = { status: "accepted", state: { observed: 0 } };
    expect(parseSnapshotMetadata(JSON.stringify({ redemption: { capacityUsd: 0, v9RouteAttempt } })).redemption)
      .toEqual({ capacityUsd: 0, v9RouteAttempt });
    const invalid = parseSnapshotMetadata(JSON.stringify({
      immediateRedeemableUsd: 1_000_000, redemption: { capacityUsd: 1_000, dailyLimitUsd: -1 },
    }));
    expect(invalid.redemption?.capacityUsd).toBeUndefined();
    expect(decodeLiveReserveRedemptionTelemetry(invalid).status).toBe("invalid");
  });

  it("accepts shared vocabularies while unknown nested values remain quarantined", () => {
    for (const adapter_source_model of LIVE_RESERVE_SOURCE_MODEL_VALUES) {
      for (const adapter_evidence_class of LIVE_RESERVE_EVIDENCE_CLASS_VALUES) {
        const decoded = parseReserveCompositionRow({
          ...row([{ name: "Cash", pct: 100, risk: "low" }]), adapter_source_model, adapter_evidence_class,
        }, null);
        expect(decoded.record).toMatchObject({ adapterSourceModel: adapter_source_model, adapterEvidenceClass: adapter_evidence_class });
      }
    }
    for (const effect of LIVE_RESERVE_WARNING_EFFECT_VALUES) {
      const decoded = parseReserveCompositionRow({ ...row([{ name: "Cash", pct: 100, risk: "low" }]),
        warning_count: 1, warnings: JSON.stringify([{ code: "source", message: "source issue", effect }]) }, null);
      expect(decoded.record?.warnings[0].effect).toBe(effect);
    }
    for (const freshnessMode of LIVE_RESERVE_FRESHNESS_MODE_VALUES) {
      expect(parseSnapshotMetadata(JSON.stringify({ freshnessMode })).freshnessMode).toBe(freshnessMode);
    }
    for (const [field, values] of [
      ["capacityKind", LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES],
      ["freshnessKind", LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES],
      ["routeStatus", LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES],
      ["routeStatusSource", LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES],
    ] as const) {
      for (const value of values) {
        expect(parseSnapshotMetadata(JSON.stringify({ redemption: { [field]: value } })).redemption?.[field]).toBe(value);
      }
      expect(decodeLiveReserveRedemptionTelemetry(
        parseSnapshotMetadata(JSON.stringify({ redemption: { [field]: "unknown-value" } })),
      ).status).toBe("invalid");
    }
  });
});
