import { describe, expect, it } from "vitest";
import { FxReferenceObservationSchema } from "../../types/fx-reference";
import { AdmittedDeviationBpsSchema, asRawDeviationBps, ReferenceAdmissionSchema, ReferenceContributorSchema, type ReferenceContributor } from "../../types/reference-admission";
import { computePeerRelativeDeviation, type PeerRelativeQuote } from "../peer-relative-deviation";
import { PEG_TAXONOMY } from "../peg-taxonomy";
import {
  admittedDeviationBps, DAILY_FIXING_MOVE_BANDS_BPS, evaluateReferenceAdmission, REFERENCE_ADMISSION_POLICY_VERSION,
  REFERENCE_INTRADAY_BUDGET_SEC, type ReferenceAdmissionInput,
} from "../reference-admission";

const sec = (iso: string) => Date.parse(iso) / 1000;
const hour = 3600;
const day = 24 * hour;
const noon = sec("2026-11-17T17:00:00Z");
const reopen = sec("2026-11-15T22:00:00Z");
const saturday = sec("2026-11-14T17:00:00Z");
const metalBreak = sec("2026-11-18T22:30:00Z");
const raw = asRawDeviationBps;
type Direct = Extract<ReferenceAdmissionInput, { kind: "fx" | "fallback" }>;
function direct(at: number, options: Partial<Omit<Direct, "observation">> = {}, obs: Partial<Direct["observation"]> = {}): Direct {
  return {
    kind: "fx", decisionAtSec: at, quoteObservedAtSec: at, generation: "fx:42", rawDeviationBps: raw(-300),
    preCloseUsdPerUnit: 1.1, ...options,
    observation: { pegKey: "peggedEUR", usdPerUnit: 1.2, source: "openExchangeRates", cadence: "intraday", observedAtSec: at, ...obs },
  };
}
function median(at: number, contributors: ReferenceContributor[]): ReferenceAdmissionInput {
  return { kind: "median", pegKey: "peggedGOLD", quoteObservedAtSec: at, decisionAtSec: at, rawDeviationBps: raw(-300), contributors };
}
const contributor = (key: string, clock: number | null, derivation: ReferenceContributor["derivation"] = "traded-market"): ReferenceContributor =>
  ({ provenanceKey: key, observedAtSec: clock, derivation });

describe("observation and admission wire contracts", () => {
  it("withholds a current deviation after six hours even while the direct or median reference stays fresh", () => {
    const quote = noon - 6 * hour;
    const observedAtSec = quote + 600;
    for (const input of [
      direct(noon, { quoteObservedAtSec: quote }, { observedAtSec }),
      { ...median(noon, ["a", "b", "c"].map((id) => contributor(id, observedAtSec))), quoteObservedAtSec: quote },
    ]) {
      expect(admittedDeviationBps(input.rawDeviationBps, evaluateReferenceAdmission(input))).toBe(-300);
      const verdict = evaluateReferenceAdmission({ ...input, decisionAtSec: noon + 1 });
      expect(verdict).toMatchObject({ status: "stale-reference", reason: "quote-over-budget", budgetSec: 6 * hour });
      expect(admittedDeviationBps(input.rawDeviationBps, verdict)).toBeNull();
      expect(evaluateReferenceAdmission({ ...input, decisionAtSec: noon + 1, purpose: "detection" })).toMatchObject({
        status: "admitted", reason: "live-reference",
      });
    }
  });

  const observation = direct(noon).observation;
  it.each([
    ["frankfurter", "business-daily"], ["openExchangeRates", "intraday"], ["fawazahmed0", "calendar-daily"],
    ["exchangeRateApi", "calendar-daily"], ["chainlink", "intraday"], ["gold-api.com", "intraday"], ["peer-median", "intraday"],
  ])("round-trips %s and its own clock", (source, cadence) => {
    const row = { ...observation, source, cadence, publishedAtSec: noon + hour };
    expect(FxReferenceObservationSchema.parse({ ...row, laterField: 1 })).toEqual(row);
  });
  it.each([
    { pegKey: "" }, { usdPerUnit: 0 }, { usdPerUnit: Infinity }, { source: "fetched" }, { cadence: "monthly" },
    { observedAtSec: null }, { observedAtSec: noon + 0.5 }, { publishedAtSec: noon - 1 },
  ])("rejects invalid observation fields %j", (fields) => {
    expect(FxReferenceObservationSchema.safeParse({ ...observation, ...fields }).success).toBe(false);
  });
  it("requires an admitted clock pair, evidence, reason and finite projection", () => {
    const result = evaluateReferenceAdmission(direct(noon));
    expect(ReferenceAdmissionSchema.parse(result)).toEqual({
      status: "admitted", reason: "live-reference", kind: "fx", source: "openExchangeRates", cadence: "intraday",
      referenceObservedAtSec: noon, quoteObservedAtSec: noon, decisionAtSec: noon, budgetSec: REFERENCE_INTRADAY_BUDGET_SEC,
      generation: "fx:42", sessionOpenedAtSec: reopen, policyVersion: REFERENCE_ADMISSION_POLICY_VERSION,
    });
    for (const fields of [{ kind: "none" }, { source: null }, { cadence: null }, { reason: "daily-fixing-only" },
      { quoteObservedAtSec: null }, { referenceObservedAtSec: null }, { quoteObservedAtSec: noon + 1 }, { referenceObservedAtSec: 0 },
      { budgetSec: null }, { status: "unavailable" }]) {
      expect(ReferenceAdmissionSchema.safeParse({ ...result, ...fields }).success).toBe(false);
    }
    expect(admittedDeviationBps(raw(-0.375), result)).toBe(-0.375);
    expect(admittedDeviationBps(raw(0), result)).toBe(0);
    expect(admittedDeviationBps(null, result)).toBeNull();
    expect(() => raw(NaN)).toThrow();
    expect(AdmittedDeviationBpsSchema.safeParse(Infinity).success).toBe(false);
    const unpaired = direct(noon, { pairingToleranceSec: 120, quoteObservedAtSec: noon - 121 });
    expect(evaluateReferenceAdmission(unpaired)).toMatchObject({ budgetSec: 120, reason: "quote-reference-unpaired" });
  });
});

describe("reference admission", () => {
  it("admits severe detections using a reference eligible at the close and a fresh quote from the closure", () => {
    const close = sec("2026-11-13T22:00:00Z");
    const options = { purpose: "detection", rawDeviationBps: raw(-2500), quoteObservedAtSec: saturday - 6 * hour } as const;
    const observation = { observedAtSec: close - 6 * hour };
    const verdict = (input = {}, obs = observation) => evaluateReferenceAdmission(direct(saturday, { ...options, ...input }, obs));
    expect(verdict().reason).toBe("severe-deviation");
    for (const overrides of [{ rawDeviationBps: raw(-2499.99) }, { quoteObservedAtSec: saturday - 6 * hour - 1 },
      { quoteObservedAtSec: close - 1 }]) expect(verdict(overrides).status).not.toBe("admitted");
    for (const observedAtSec of [close + 1, close - 6 * hour - 1]) expect(verdict({}, { observedAtSec }).status).not.toBe("admitted");
  });
  it("requires original quote clocks from distinct bullion tokens for a severe same-venue median", () => {
    const members = ["a", "b", "c"].map((assetId) => ({ ...contributor("coingecko", saturday - 60, "spot-derived"),
      assetId, observedAtMode: "upstream" as const }));
    const compare = (members: ReferenceContributor[], bps = -2500) => evaluateReferenceAdmission({
      ...median(saturday, members), purpose: "detection", rawDeviationBps: raw(bps),
    });
    expect(compare(members).reason).toBe("severe-deviation");
    expect(compare(members, -2499.99).reason).toBe("reference-market-closed");
    expect(compare([members[0], members[1], members[1]]).status).not.toBe("admitted");
    expect(compare([{ ...members[0], observedAtMode: "local_fetch" }, ...members.slice(1)]).status).not.toBe("admitted");
  });
  it("pairs OXR for one hourly poll beyond its accepted snapshot age", () => {
    const obs = { observedAtSec: noon - 3 * hour };
    expect(evaluateReferenceAdmission(direct(noon, { purpose: "detection" }, obs)).reason).toBe("live-reference");
    expect(evaluateReferenceAdmission(direct(noon, { purpose: "detection" }, { observedAtSec: obs.observedAtSec - 1 })))
      .toMatchObject({ reason: "quote-reference-unpaired", budgetSec: 3 * hour });
  });

  it("admits Friday's eligible close at the EUR weekend band only with a stable cohort and fresh independent native trade", () => {
    const close = sec("2026-11-13T22:00:00Z");
    const observation = { observedAtSec: close - 300 };
    const closureBenchmark = { cohort: "near-benchmark", nativeObservedAtSec: saturday - 60, nativeDeviationBps: -160, triggerBps: 150 } as const;
    const input = direct(saturday, { purpose: "detection", pairingToleranceSec: day, closureBenchmark }, observation);
    expect(evaluateReferenceAdmission(input).reason).toBe("closure-move-above-band");
    for (const changed of [
      { rawDeviationBps: raw(-299.99) },
      { closureBenchmark: { ...closureBenchmark, cohort: "missing" as const } },
      { closureBenchmark: { ...closureBenchmark, cohort: "shifted" as const } },
      { closureBenchmark: { ...closureBenchmark, nativeDeviationBps: 160 } },
      { closureBenchmark: { ...closureBenchmark, nativeObservedAtSec: close - 1 } },
      { quoteObservedAtSec: close - 1 },
      { observation: { ...input.observation, observedAtSec: close - 6 * hour - 1 } },
    ]) expect(evaluateReferenceAdmission({ ...input, ...changed }).status).not.toBe("admitted");
  });
  const directCases = {
    "unavailable": [
      ["no denominator", { kind: "none", decisionAtSec: noon, quoteObservedAtSec: noon, rawDeviationBps: raw(3000) }, "no-reference"],
      ["undated reference", direct(noon, {}, { observedAtSec: null }), "reference-clock-unavailable"],
      ["undated quote", direct(noon, { quoteObservedAtSec: null }), "quote-clock-unavailable"],
      ["future reference", direct(noon, {}, { observedAtSec: noon + 1 }), "reference-clock-unavailable"],
      ["future quote", direct(noon, { quoteObservedAtSec: noon + 1 }), "quote-clock-unavailable"],
      ["future publication", direct(noon, {}, { publishedAtSec: noon + 1 }), "invalid-reference"],
      ["pre-observation publication", direct(noon, {}, { publishedAtSec: noon - 1 }), "invalid-reference"],
      ["unknown unit", direct(noon, {}, { pegKey: "unknown" }), "invalid-reference"],
      ["bad rate", direct(noon, {}, { usdPerUnit: 0 }), "invalid-reference"],
      ["median with no contributors disguised as FX", direct(noon, {}, { source: "peer-median" }), "invalid-reference"],
      ["intraday label on ECB", direct(noon, {}, { source: "frankfurter" }), "invalid-reference"],
      ["bad tolerance", direct(noon, { pairingToleranceSec: -1 }), "invalid-reference"],
      ["severe with missing clock", direct(saturday, { rawDeviationBps: raw(2500), quoteObservedAtSec: null }), "quote-clock-unavailable"],
    ],
    "admitted": [
      ["inclusive six-hour budget", direct(noon, { quoteObservedAtSec: noon - 6 * hour }, { observedAtSec: noon - 6 * hour }), "live-reference"],
      ["inclusive pairing tolerance", direct(noon, { quoteObservedAtSec: noon - 2 * hour }), "live-reference"],
      ["changed after reopen", direct(reopen + 1), "live-reference"],
      ["3600s apart", direct(reopen + hour, { preCloseUsdPerUnit: null, firstInSessionObservedAtSec: reopen }), "live-reference"],
      ["negative severe", direct(saturday, { rawDeviationBps: raw(-2500) }), "severe-deviation"],
      ["positive severe", direct(saturday, { rawDeviationBps: raw(2500) }), "severe-deviation"],
      ["FX during maintenance", direct(metalBreak), "live-reference"],
      ["silver spot after break", direct(metalBreak + hour, { kind: "fallback" }, { source: "gold-api.com", pegKey: "peggedSILVER" }), "live-reference"],
    ],
    "stale-reference": [
      ["aged pair", direct(noon, { quoteObservedAtSec: noon - 6 * hour }, { observedAtSec: noon - 6 * hour - 1 }), "reference-over-budget"],
      ["older numerator", direct(noon, { quoteObservedAtSec: noon - 2 * hour - 1 }), "quote-reference-unpaired"],
      ["older denominator", direct(noon, {}, { observedAtSec: noon - 2 * hour - 1 }), "quote-reference-unpaired"],
      ["seven-day-old token", direct(noon, { quoteObservedAtSec: noon - 7 * day }), "quote-reference-unpaired"],
      ["custom tolerance", direct(noon, { pairingToleranceSec: 0 }, { observedAtSec: noon - 1 }), "quote-reference-unpaired"],
      ["quote from closure", direct(reopen + 30, { quoteObservedAtSec: reopen - 1 }), "quote-before-reopen"],
      ["reference from closure", direct(reopen + 30, {}, { observedAtSec: reopen - 1 }), "reference-before-reopen"],
      ["reference stamped at reopen", direct(reopen), "reference-before-reopen"],
      ["re-stamped close", direct(reopen + hour, { preCloseUsdPerUnit: 1.2 }), "reference-not-repriced"],
      ["no prior evidence", direct(noon, { preCloseUsdPerUnit: null }), "reference-not-repriced"],
      ["pre-session snapshot", direct(reopen + hour, { preCloseUsdPerUnit: null, firstInSessionObservedAtSec: reopen - 1 }), "reference-not-repriced"],
      ["3599s apart", direct(reopen + hour - 1, { preCloseUsdPerUnit: 1.2, firstInSessionObservedAtSec: reopen }), "reference-not-repriced"],
      ["severe with unpaired clock", direct(saturday, { rawDeviationBps: raw(2500), quoteObservedAtSec: saturday - day }), "quote-reference-unpaired"],
      ["closed severe fixing on display", direct(saturday, { rawDeviationBps: raw(3000) }, { source: "fawazahmed0", cadence: "calendar-daily" }), "daily-fixing-only"],
      ["severe cannot date an ECB fixing on Saturday", direct(saturday, { purpose: "detection", rawDeviationBps: raw(3000) },
        { source: "frankfurter", cadence: "business-daily" }), "daily-fixing-only"],
    ],
    "held-closed-session": [
      ["Friday spot carried into closure", direct(saturday), "reference-market-closed"],
      ["fractional sub-severe", direct(saturday, { rawDeviationBps: raw(-2499.99) }), "reference-market-closed"],
      ["metal maintenance", direct(metalBreak, { kind: "fallback" }, { source: "gold-api.com", pegKey: "peggedGOLD" }), "reference-market-closed"],
    ],
  } as const;
  for (const [status, rows] of Object.entries(directCases)) {
    it.each<readonly [string, ReferenceAdmissionInput, string]>(rows)("%s", (_label, input, reason) => {
      const verdict = evaluateReferenceAdmission(input);
      expect(ReferenceAdmissionSchema.parse(verdict)).toMatchObject({ status, reason });
      expect(admittedDeviationBps(input.rawDeviationBps, verdict)).toBe(status === "admitted" ? input.rawDeviationBps : null);
    });
  }

  it.each([
    ["all traded", contributor("c", saturday), "admitted", "closed-session-traded-median"],
    ["NAV", contributor("c", saturday, "nav"), "held-closed-session", "reference-market-closed"],
    ["oracle", contributor("c", saturday, "oracle"), "held-closed-session", "reference-market-closed"],
    ["spot-derived", contributor("c", saturday, "spot-derived"), "held-closed-session", "reference-market-closed"],
    ["mirror", contributor(" a ", saturday), "held-closed-session", "reference-market-closed"],
    ["unknown venue", contributor(" ", saturday), "held-closed-session", "reference-market-closed"],
    ["missing clock", contributor("c", null), "unavailable", "reference-clock-unavailable"],
    ["future contributor", contributor("c", saturday + 1), "unavailable", "reference-clock-unavailable"],
  ] as const)("median during closure with %s", (_label, third, status, reason) => {
    expect(ReferenceContributorSchema.parse(third)).toEqual(third);
    const verdict = evaluateReferenceAdmission(median(saturday, [contributor("a", saturday - 27), contributor("b", saturday), third]));
    expect(ReferenceAdmissionSchema.parse(verdict)).toMatchObject({ status, reason, generation: null, source: "peer-median",
      referenceObservedAtSec: status === "unavailable" ? null : saturday - 27 });
  });

  it("dates the actual median, counts in-closure trades only and requires an open-session quorum", () => {
    const at = metalBreak;
    const contributors = [contributor("a", at - 31 * 60), contributor("b", at), contributor("c", at)];
    expect(evaluateReferenceAdmission(median(at, contributors))).toMatchObject({ status: "held-closed-session", referenceObservedAtSec: at - 31 * 60 });
    expect(evaluateReferenceAdmission(median(at, [...contributors, contributor("d", at)]))).toMatchObject({
      status: "admitted", reason: "closed-session-traded-median", referenceObservedAtSec: at - 31 * 60,
    });
    expect(evaluateReferenceAdmission(median(noon, [contributor("a", noon), contributor("b", noon)]))).toMatchObject({ reason: "insufficient-contributors" });
    expect(evaluateReferenceAdmission(median(noon, [contributor("a", noon - 27), contributor("b", noon), contributor("c", noon)]))).toMatchObject({
      status: "admitted", referenceObservedAtSec: noon - 27, budgetSec: 6 * hour,
    });
  });

  it.each([
    ["peggedEUR", "EUR", "business-daily", "frankfurter", "2026-11-17T13:10:00Z", 1],
    ["peggedREAL", "BRL", "business-daily", "frankfurter", "2026-11-16T13:10:00Z", 2],
    ["peggedCOP", "COP", "calendar-daily", "fawazahmed0", "2026-11-16T00:00:00Z", 3],
  ] as const)("gates a %s fixing for detection by its age band", (pegKey, currency, cadence, source, fixing, bucket) => {
    const observedAtSec = sec(fixing);
    const at = sec(["", "2026-11-17T16:00:00Z", "2026-11-18T13:10:00Z", "2026-11-19T01:00:00Z"][bucket]);
    const band = DAILY_FIXING_MOVE_BANDS_BPS[currency]![bucket];
    const input = direct(at, { purpose: "detection", rawDeviationBps: raw(-band - 0.1) },
      { pegKey, cadence, source, observedAtSec });
    expect(evaluateReferenceAdmission(input)).toMatchObject({ status: "admitted", reason: "daily-fixing-above-band", budgetSec: at - reopen });
    expect(evaluateReferenceAdmission({ ...input, rawDeviationBps: raw(band) })).toMatchObject({ status: "stale-reference", reason: "daily-fixing-only" });
    expect(evaluateReferenceAdmission({ ...input, purpose: "current" })).toMatchObject({ status: "stale-reference", reason: "daily-fixing-only" });
    expect(evaluateReferenceAdmission({ ...input, dailyFixingBudgetSec: at - observedAtSec - 1, pairingToleranceSec: 4 * day })).toMatchObject({ reason: "reference-over-budget" });
  });

  it("keeps dated fixings inside their session and independent of quota, publication and refresh clocks", () => {
    const easterMonday = sec("2027-03-29T15:00:00Z");
    const detection = { purpose: "detection", rawDeviationBps: raw(3000), dailyFixingBudgetSec: 5 * day } as const;
    const fix = { source: "frankfurter", cadence: "business-daily", publishedAtSec: easterMonday } as const;
    expect(evaluateReferenceAdmission(direct(easterMonday, detection, { ...fix, observedAtSec: sec("2027-03-25T13:10:00Z") }))).toMatchObject({ reason: "reference-before-reopen" });
    expect(evaluateReferenceAdmission(direct(easterMonday, detection, fix))).toMatchObject({ reason: "daily-fixing-only" });
    const oldPair = direct(noon, { ...detection, quoteObservedAtSec: noon - day }, { ...fix, observedAtSec: noon - day, publishedAtSec: noon - day });
    expect(evaluateReferenceAdmission(oldPair)).toMatchObject({ reason: "quote-over-budget", budgetSec: 6 * hour });
    expect(Object.keys(DAILY_FIXING_MOVE_BANDS_BPS).sort()).toEqual(Object.values(PEG_TAXONOMY)
      .filter((entry) => entry.pegClass === "fiat_fx").map((entry) => entry.currency).sort());
    expect(() => evaluateReferenceAdmission(direct(NaN))).toThrow(RangeError);
  });
});

describe("peer-relative deviation", () => {
  const peer = (id: string, priceUsd = 1, opts: Partial<PeerRelativeQuote> = {}): PeerRelativeQuote =>
    ({ id, priceUsd, pegKey: "peggedEUR", observedAtSec: noon, provenanceKey: id, hasOpenEvent: false, ...opts });
  const subject = peer("subject", 0.96123);
  const compare = (peers: PeerRelativeQuote[]) => computePeerRelativeDeviation({ subject, peers, nowSec: noon, maxAgeSec: hour });
  it.each([
    ["only the subject", subject], ["another peg", peer("c", 1, { pegKey: "peggedGBP" })],
    ["open event", peer("c", 1, { hasOpenEvent: true })], ["stale", peer("c", 1, { observedAtSec: noon - hour - 1 })],
    ["future", peer("c", 1, { observedAtSec: noon + 1 })], ["missing provenance", peer("c", 1, { provenanceKey: " " })],
    ["venue mirror", peer("c", 1, { provenanceKey: "a" })], ["same token", peer("b", 1, { provenanceKey: "other" })],
    ["invalid price", peer("c", NaN)], ["zero price", peer("c", 0)],
  ] as const)("cannot build a third independent peer from %s", (_label, third) => {
    expect(compare([peer("a"), peer("b"), third])).toEqual({ ok: false, reason: "insufficient-peers" });
  });

  it("reports the contributing quotes, signed unrounded move and even/odd median", () => {
    const peers = [peer("a", 0.97, { observedAtSec: noon - hour }), peer("b", 1), peer("c", 1.1)];
    const olderMirror = peer("mirror", 1.7, { provenanceKey: "c", observedAtSec: noon - 1 });
    const odd = compare([subject, olderMirror, ...peers]);
    expect(odd).toMatchObject({ ok: true, medianUsd: 1 });
    if (!odd.ok) throw new Error(odd.reason);
    expect(odd.contributors.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
    expect(odd.deviationBps).toBeCloseTo(-387.7, 8);
    const even = computePeerRelativeDeviation({ subject: peer("subject", 1.25), peers: [...peers, peer("d", 2)], nowSec: noon, maxAgeSec: hour });
    expect(even).toMatchObject({ ok: true, medianUsd: 1.05 });
    if (even.ok) expect(even.deviationBps).toBeCloseTo((1.25 / 1.05 - 1) * 10_000);
    const cohort = computePeerRelativeDeviation({ subject, peers: peers.map((row) => ({ ...row, priceUsd: subject.priceUsd })), nowSec: noon, maxAgeSec: hour });
    expect(cohort).toMatchObject({ ok: true, deviationBps: 0 });
    expect(compare([...peers, peer("c", 1, { hasOpenEvent: true })])).toEqual({ ok: false, reason: "insufficient-peers" });
  });

  it("quarantines conflicting newest peer prices in either input order", () => {
    const healthy = [peer("a", 1), peer("b", 2), peer("c", 3)];
    const disputed = [peer("d", 1.5), peer("d", 2.5)];
    for (const rows of [disputed, [...disputed].reverse()]) {
      expect(compare([...healthy, ...rows, peer("d", 4, { observedAtSec: noon - 1 })])).toEqual(compare(healthy));
    }
  });

  it.each([
    [{ nowSec: NaN }, "invalid-clock"], [{ maxAgeSec: -1 }, "invalid-clock"],
    [{ subject: peer("subject", 0) }, "invalid-subject"], [{ subject: peer("subject", 1, { observedAtSec: noon - hour - 1 }) }, "invalid-subject"],
    [{ subject: peer("subject", Number.MAX_VALUE), peers: ["a", "b", "c"].map((id) => peer(id, Number.MIN_VALUE)) }, "invalid-deviation"],
  ] as const)("rejects invalid inputs %o", (options, reason) => {
    expect(computePeerRelativeDeviation({ subject, peers: [], nowSec: noon, maxAgeSec: hour, ...options })).toEqual({ ok: false, reason });
  });
});
