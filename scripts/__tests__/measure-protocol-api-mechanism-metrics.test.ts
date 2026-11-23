import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchProtocolApiObservation as fetchObs, readProtocolApiArtifact as readArt, runProtocolApiMeasurementCli as runCliFn } from "../maintenance/measure-protocol-api-mechanism-metrics";
import { buildProtocolApiMeasurement as build, ETHENA_PROTOCOL_API_URLS as ETHENA_URLS, FALCON_TRANSPARENCY_URL as FALCON_URL, isSameProtocolApiSourceSnapshot as sameSnap, protocolApiEvidenceFilename as artFile, ProtocolApiMechanismMeasurementSchema as ArtSchema, replayProtocolApiMeasurement as replay, serializeProtocolApiMeasurement as ser, validateProtocolApiArtifactSet as valSet, type ProtocolApiMechanismMeasurement, type RawProtocolApiObservationInput } from "../lib/mechanism-measurement/protocol-api";
import { buildMechanismCaptureSummary as buildSum, summaryPathForCapture as sumPath } from "../lib/mechanism-measurement/capture-summary";

const CLI_SCRIPT = resolve("scripts/maintenance/measure-protocol-api-mechanism-metrics.ts");
const TSX_LOADER = import.meta.resolve("tsx");
const CAP_AT = new Date("2026-07-22T20:05:00.000Z");
const LEGACY = "shared/data/safety-score-v9/mechanism-measurements/usde-ethena/2026-07-22T20-00-16.250Z-protocol-api.json";
const js = JSON.stringify;

const runProtocolCli = (args: readonly string[], cwd: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") };
  delete env.CLOUDFLARE_ACCOUNT_ID; delete env.R2_MEASUREMENTS_ACCESS_KEY_ID; delete env.R2_MEASUREMENTS_SECRET_ACCESS_KEY;
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_SCRIPT, ...args], { cwd, env, encoding: "utf8", timeout: 15_000 });
};
const withTmp = async <T>(pfx: string, fn: (dir: string) => Promise<T> | T) => {
  const dir = mkdtempSync(join(tmpdir(), pfx));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const raw = (sourceId: string, url: string, body: string, headers: Record<string, string> = {}): RawProtocolApiObservationInput => ({ sourceId, url, rawBody: Buffer.from(body), headers });
const usdeIn = (o: { statusTimestamp?: string; porAt?: string; confirmed?: boolean; deltaNeutral?: boolean; backing?: string } = {}) => {
  const porAt = o.porAt ?? "2026-07-17T00:06:43.000Z";
  return [
    raw("ethena-collateralization-status", ETHENA_URLS.collateralizationStatus, `{"timestamp":"${o.statusTimestamp ?? "2026-07-22 20:00:16.250683 UTC"}","totalBackingAssetsInUsd":${o.backing ?? "4032944678.04"},"totalReserveFundInUsd":62097782.084185585,"totalTokenSupplyInUsd":4028272966.14659}`),
    raw("ethena-proof-of-reserves", ETHENA_URLS.proofOfReserves, js({ lastUpdatedAt: porAt, reports: [{ auditors: [{ name: "HarrisAndTrotter", is_confirmed: o.confirmed ?? true }, { name: "Chainlink", is_confirmed: o.confirmed ?? true }], date: porAt, deltaNeutral: o.deltaNeutral ?? true, overCollateralized: o.deltaNeutral ?? true }] })),
  ];
};
const falconBody = (o: { snapshotDate?: string; tvl?: string; supply?: string; insurance?: string; firstCell?: string; reserves?: Record<string, Record<string, string>> } = {}) =>
  `{"snapshot_date":${o.snapshotDate ?? "1784750400"},"tvl":"${o.tvl ?? "100"}","usdf":{"supply":"${o.supply ?? "90"}","insurance_fund":"${o.insurance ?? "1"}","reserves":${js(o.reserves ?? { ceffu: { stablecoins: "105", btc: "0" } })},"venues":{},"breakdown":{"assets":[{"label":"USDC","ceffu":${o.firstCell ?? '"60"'},"fireblocks":"20"},{"label":"BTC","multisig":"20"}]}}}`;
const falconIn = (body = falconBody(), headers: Record<string, string> = {}) => [raw("falcon-transparency", FALCON_URL, body, headers)];
const buildU = (o?: Parameters<typeof usdeIn>[0], at = CAP_AT) => build("usde-ethena", usdeIn(o), at);
const buildF = (o?: Parameters<typeof falconBody>[0], at = CAP_AT) => build("usdf-falcon", falconIn(falconBody(o)), at);
const metric = (a: ProtocolApiMechanismMeasurement, id: string) => a.metrics.find((c) => c.id === id)!;
const resp = (body: BodyInit | null, init: ResponseInit & { redirected?: boolean; url?: string } = {}) => {
  const { redirected = false, url = "", ...ri } = init, r = new Response(body, ri);
  Object.defineProperties(r, { redirected: { configurable: true, value: redirected }, url: { configurable: true, value: url } });
  return r;
};
const tRec = (m: string) => JSON.parse(m.slice(m.indexOf("transport=") + 10)) as Record<string, unknown>;

describe("protocol API response transport", () => {
  const src = { sourceId: "ethena-collateralization-status", url: ETHENA_URLS.collateralizationStatus };

  it.each([
    ["text/html", "<!doctype html><title>body-sentinel</title>", "non-JSON media type", "non-json-media-type"],
    ["application/json", "<html>body-sentinel</html>", "unexpected html-like body", "unexpected-body-class"],
    ["application/json", "   \n\t", "unexpected empty body", "unexpected-body-class"],
  ])("rejects %s non-JSON responses without logging body bytes", async (ct, body, exp, reason) => {
    const logs: string[] = []; let err = "";
    try { await fetchObs(src, { fetchImpl: async () => resp(body, { headers: { "content-type": ct }, status: 200 }), log: (m) => logs.push(m) }); }
    catch (c) { err = c instanceof Error ? c.message : String(c); }
    expect(err).toContain(exp); expect(err).toContain(src.sourceId);
    expect(`${logs.join("\n")}\n${err}`).not.toContain("body-sentinel");
    expect(tRec(logs[0]!)).toMatchObject({ bodyBytes: Buffer.byteLength(body), sourceId: src.sourceId, status: 200, reason });
  });

  it.each([["text/html; charset=utf-8", "non-json-media-type"], ["application/json", "unexpected-body-class"]])(
    "rejects restricted HTML advertised as %s with a machine-readable reason", async (ct, reason) => {
      const body = readFileSync(new URL("./fixtures/ethena-restricted.html", import.meta.url), "utf8");
      const up = resp(body, { headers: { "content-type": ct }, redirected: true, status: 200, url: "https://ethena.fi/restricted" });
      const fetchImpl = vi.fn(async () => up), ab = vi.spyOn(up, "arrayBuffer"), logs: string[] = [];
      const req = fetchObs(src, { fetchImpl, log: (m) => logs.push(m) });
      await expect(req).rejects.toThrow();
      const err = await req.catch((c: Error) => c.message);
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(ab).toHaveBeenCalledTimes(1); expect(logs).toHaveLength(1);
      expect(tRec(logs[0]!)).toMatchObject({ sourceId: src.sourceId, configuredUrl: src.url, finalUrl: "https://ethena.fi/restricted", status: 200, redirected: true, mediaType: ct.split(";", 1)[0], bodyBytes: Buffer.byteLength(body), bodySha256: createHash("sha256").update(body).digest("hex"), bodyClass: "html-like", reason });
      expect(err).toContain(`"reason":"${reason}"`);
      expect(`${logs.join("\n")}\n${err}`).not.toMatch(/Access Restricted|not available in your country/);
    },
  );

  it("consumes non-success responses once and reports bounded provenance", async () => {
    const up = resp("upstream-body-sentinel", { headers: { "content-type": "text/html", server: "Vercel" }, status: 403 }), ab = vi.spyOn(up, "arrayBuffer"), logs: string[] = [];
    await expect(fetchObs(src, { fetchImpl: async () => up, log: (m) => logs.push(m) })).rejects.toThrow(/HTTP 403/);
    expect(ab).toHaveBeenCalledTimes(1); expect(logs.join("\n")).not.toContain("upstream-body-sentinel");
    expect(tRec(logs[0]!)).toMatchObject({ bodyClass: "other", headers: { server: "Vercel" }, status: 403, reason: "http-error" });
  });

  it.each(["application/json; charset=utf-8", "application/problem+json"])("accepts %s and preserves the exact response bytes", async (ct) => {
    const body = '{"exact":"bytes"}\n', obs = await fetchObs(src, { fetchImpl: async () => resp(body, { headers: { "content-type": ct }, status: 200 }), log: () => undefined });
    expect(Buffer.from(obs.rawBody)).toEqual(Buffer.from(body));
  });

  it("sanitizes URLs and bounds the allowlisted edge headers", async () => {
    const logs: string[] = [], cfg = { ...src, url: `${src.url.replace("https://", "https://configured-user:configured-password@")}?configured-secret=value#fragment` };
    const obs = await fetchObs(cfg, { fetchImpl: async () => resp('{"ok":true}', { headers: { authorization: "body-sentinel", "content-type": "application/json", "x-vercel-id": "v".repeat(300) }, redirected: true, status: 200, url: `${src.url.replace("https://", "https://redirect-user:redirect-password@")}?redirect-secret=value#fragment` }), log: (m) => logs.push(m) });
    const prov = tRec(logs[0]!) as { configuredUrl: string; finalUrl: string; headers: Record<string, string>; redirected: boolean };
    expect(prov).toMatchObject({ configuredUrl: src.url, finalUrl: src.url, redirected: true });
    expect(prov.headers["x-vercel-id"]).toHaveLength(160);
    expect(logs[0]).not.toMatch(/configured-secret|redirect-secret|body-sentinel|configured-user|configured-password|redirect-user|redirect-password/);
    expect(obs.url).toBe(cfg.url);
  });

  it("removes configured and redirected userinfo from rejection diagnostics", async () => {
    const logs: string[] = [];
    const req = fetchObs({ ...src, url: "https://configured-user:configured-password@example.com/configured" }, { fetchImpl: async () => resp("denied", { status: 403, url: "https://redirect-user:redirect-password@example.com/redirected", redirected: true }), log: (m) => logs.push(m) });
    await expect(req).rejects.toThrow(/HTTP 403/);
    const err = await req.catch((c: Error) => c.message);
    expect(`${logs.join("\n")}\n${err}`).not.toMatch(/configured-user|configured-password|redirect-user|redirect-password/);
    expect(tRec(logs[0]!)).toMatchObject({ configuredUrl: "https://example.com/configured", finalUrl: "https://example.com/redirected" });
  });

  it("leaves malformed JSON rejection with the existing lossless parser", async () => {
    const obs = await fetchObs(src, { fetchImpl: async () => resp("{broken", { headers: { "content-type": "application/json" }, status: 200 }), log: () => undefined });
    expect(() => build("usde-ethena", [obs, usdeIn()[1]!], CAP_AT)).toThrow(/JSON|value|quoted|symbol/i);
  });
});

describe("protocol API Artifact V2", () => {
  it("derives exact USDe metrics from raw numeric tokens and replays byte-identically", () => {
    const inputs = usdeIn(), digest = createHash("sha256").update(inputs[0]!.rawBody).digest("base64");
    inputs[0] = { ...inputs[0]!, headers: { "Content-Digest": `sha-256=:${digest}:`, ETag: '"snapshot"' } };
    const a = build("usde-ethena", inputs, CAP_AT);
    expect(ArtSchema.parse(a)).toEqual(a);
    expect(metric(a, "collateralizationRatio")).toMatchObject({ state: "measured", value: "1.001159730717", derivation: { numerator: "4032944678.04", denominator: "4028272966.14659", rounding: "half-up", scale: 12 } });
    expect(metric(a, "reserveExcessPct")).toMatchObject({ state: "measured", value: "0.115973071653" });
    expect(metric(a, "dedicatedLossAbsorptionShare")).toMatchObject({ state: "measured", value: "0.015415485149" });
    expect(metric(a, "hedgeCoverageRatio")).toMatchObject({ state: "unavailable" });
    expect(a.claims).toEqual([
      { id: "deltaNeutral", value: true, observedAt: "2026-07-17T00:06:43.000Z", sourceObservationIds: ["ethena-proof-of-reserves"] },
      { id: "overCollateralized", value: true, observedAt: "2026-07-17T00:06:43.000Z", sourceObservationIds: ["ethena-proof-of-reserves"] },
    ]);
    expect(a.observations[0]).toMatchObject({ contentDigestVerification: "verified", headers: { "content-digest": `sha-256=:${digest}:`, etag: '"snapshot"' } });
    expect(ser(replay(a))).toBe(ser(a)); expect(artFile(a)).toMatch(/^2026-07-22T20-00-16\.250Z-[0-9a-f]{12}-protocol-api\.json$/);
  });

  it.each([["2026-07-22T20:00:16Z", "2026-07-22T20:00:16.000Z"], ["2026-07-22T20:00:16.250683Z", "2026-07-22T20:00:16.250Z"], ["2026-07-22T20:00:16.000000Z", "2026-07-22T20:00:16.000Z"]])(
    "normalizes Ethena ISO UTC timestamp %s and replays the original bytes", (ts, obsAt) => {
      const a = buildU({ statusTimestamp: ts });
      expect(a.observations[0]!.observedAt).toBe(obsAt); expect(a.snapshotObservedAt).toBe(obsAt); expect(ser(replay(a))).toBe(ser(a));
    },
  );

  it.each(["2026-02-30T20:00:16.000000Z", "2026-07-22T24:00:00.000000Z", "2026-07-22T20:00:16.000000", "2026-07-22T20:00:16.000000+00:00", "2026-07-22T20:00:16.000000 UTC", "2026-07-22 20:00:16.000000Z"])(
    "rejects invalid or unsupported Ethena timestamp %s", (ts) => { expect(() => buildU({ statusTimestamp: ts })).toThrow(/Invalid Ethena collateralization timestamp/); },
  );

  it("records adverse claims without inventing unavailable trading-risk metrics", () => {
    const a = buildU({ backing: "3900000000", deltaNeutral: false });
    expect(a.claims.map((c) => c.value)).toEqual([false, false]);
    expect(metric(a, "reserveExcessPct")).toMatchObject({ state: "measured", value: "-3.184316634562" });
    expect(a.metrics.filter((c) => c.state === "unavailable")).toHaveLength(4);
    expect(a.adoptionEligibility.status).toBe("blocked"); expect(a.scoreImpactAssessment.expectedEffect).toBe("confirm");
  });

  it("fails closed on stale, future, and unconfirmed Ethena source data", () => {
    expect(() => buildU({ statusTimestamp: "2026-07-21 01:00:00 UTC" })).toThrow(/status is stale/);
    expect(() => buildU({ statusTimestamp: "2026-07-22 20:11:00 UTC" })).toThrow(/future/);
    expect(() => buildU({ porAt: "2026-07-01T00:00:00.000Z" })).toThrow(/proof of reserves is stale/);
    expect(() => buildU({ confirmed: false })).toThrow(/no confirmed auditor/);
  });

  it("binds both observations into identity and rejects raw-byte tampering and same-time conflicts", () => {
    const first = buildU(), chPor = buildU({ deltaNeutral: false });
    expect(chPor.observations[0]!.observationHash).toBe(first.observations[0]!.observationHash);
    expect(chPor.snapshotId).not.toBe(first.snapshotId);
    expect(() => valSet([first, chPor])).toThrow(/same observation-time vector/);
    const tamp = structuredClone(first); tamp.observations[0]!.rawBodyBase64 = Buffer.from("{}").toString("base64");
    expect(() => replay(tamp)).toThrow(/raw-body hash mismatch/);
    const tId = structuredClone(first); tId.snapshotId = "0".repeat(64); expect(() => ArtSchema.parse(tId)).toThrow(/snapshot ID mismatch/);
    const unk = structuredClone(first); unk.metrics[0]!.sourceObservationIds = ["not-a-recorded-source"]; expect(() => ArtSchema.parse(unk)).toThrow(/unknown source observation ID/);
    const retry = buildU(undefined, new Date("2026-07-22T20:06:00.000Z"));
    expect(retry.snapshotId).toBe(first.snapshotId); expect(retry.capturedAt).not.toBe(first.capturedAt);
    const rot = usdeIn(); rot[0] = { ...rot[0]!, headers: { ETag: '"rotated"' } };
    expect(sameSnap(first, build("usde-ethena", rot, new Date("2026-07-22T20:06:00.000Z")))).toBe(true);
    expect(first.capturedAt).toBe(CAP_AT.toISOString()); expect(first.observations[0]!.headers).toEqual({});
  });

  it("normalizes source exponent notation without floating-point coercion", () => {
    const inputs = usdeIn();
    inputs[0] = raw("ethena-collateralization-status", ETHENA_URLS.collateralizationStatus, '{"timestamp":"2026-07-22 20:00:16 UTC","totalBackingAssetsInUsd":1.01e2,"totalReserveFundInUsd":1e0,"totalTokenSupplyInUsd":1e2}');
    const a = build("usde-ethena", inputs, CAP_AT);
    expect(metric(a, "collateralizationRatio")).toMatchObject({ value: "1.01" });
    expect(a.observations[0]!.parsedPayload).toMatchObject({ totalBackingAssetsInUsd: "101" });
  });

  it("rejects malformed monetary tokens and required-field schema drift", () => {
    for (const body of ['{"timestamp":"2026-07-22 20:00:16 UTC","totalBackingAssetsInUsd":"101","totalReserveFundInUsd":1,"totalTokenSupplyInUsd":100}', '{"timestamp":"2026-07-22 20:00:16 UTC","totalBackingAssetsInUsd":101,"totalReserveFundInUsd":1}']) {
      const inputs = usdeIn(); inputs[0] = raw("ethena-collateralization-status", ETHENA_URLS.collateralizationStatus, body);
      expect(() => build("usde-ethena", inputs, CAP_AT)).toThrow();
    }
  });
});

describe("Falcon transparency target", () => {
  it("accepts and exactly normalizes the live mix of quoted and numeric-token asset cells", () => {
    const a = buildF({ firstCell: "60" });
    expect(a.snapshotObservedAt).toBe("2026-07-22T20:00:00.000Z");
    expect(metric(a, "collateralizationRatio")).toMatchObject({ state: "measured", value: "1.111111111111" });
    expect(metric(a, "reserveExcessPct")).toMatchObject({ state: "measured", value: "11.111111111111" });
    expect(metric(a, "dedicatedLossAbsorptionShare")).toMatchObject({ state: "measured", value: "0.011111111111" });
    expect(a.breakdowns[0]!.entries).toEqual([
      { key: "BTC", amountUsd: "20", share: "0.2", shareDerivation: { formulaId: "allocation-share", numerator: "20", denominator: "100", rounding: "half-up", scale: 12 } },
      { key: "USDC", amountUsd: "80", share: "0.8", shareDerivation: { formulaId: "allocation-share", numerator: "80", denominator: "100", rounding: "half-up", scale: 12 } },
    ]);
    expect(a.breakdowns[1]!.entries.map(({ key, amountUsd, share }) => ({ key, amountUsd, share }))).toEqual([{ key: "ceffu", amountUsd: "60", share: "0.6" }, { key: "fireblocks", amountUsd: "20", share: "0.2" }, { key: "multisig", amountUsd: "20", share: "0.2" }]);
    expect(a.reconciliations.map((e) => e.status)).toEqual(["pass", "unresolved", "unresolved"]);
    expect(a.metrics.filter((c) => c.state === "unavailable")).toHaveLength(4);
    expect(a.scoreImpactAssessment.expectedEffect).toBe("indeterminate");
    expect(a.observations[0]!.parsedPayload).toMatchObject({ snapshot_date: "1784750400" });
    expect((a.observations[0]!.parsedPayload as { usdf: { breakdown: { assets: Array<Record<string, string>> } } }).usdf.breakdown.assets[0]).toEqual({ label: "USDC", ceffu: "60", fireblocks: "20" });
  });

  it.each(["false", "null", '"not-a-decimal"', "-1", '"-1"'])("rejects invalid or negative Falcon asset cell %s", (firstCell) => {
    expect(() => buildF({ firstCell })).toThrow(/not a decimal|negative/);
  });

  it("fails closed when asset rows drift from TVL or required Falcon objects disappear", () => {
    expect(() => buildF({ tvl: "101" })).toThrow(/do not reconcile/);
    expect(() => build("usdf-falcon", falconIn(falconBody().replace('"venues":{},', "")), CAP_AT)).toThrow();
    expect(() => buildF({ snapshotDate: "1784751060" })).toThrow(/future/);
    expect(() => buildF({ reserves: {} })).toThrow(/at least one custodian amount/);
    expect(() => buildF({ reserves: { ceffu: {} } })).toThrow(/at least one custodian amount/);
  });

  it("keeps published reserves and insurance outside reconciled backing", () => {
    const a = buildF({ insurance: "10", reserves: { ceffu: { stablecoins: "104.956", btc: "0" } } });
    expect(metric(a, "collateralizationRatio")).toMatchObject({ value: "1.111111111111", derivation: { numerator: "100" } });
    expect(metric(a, "dedicatedLossAbsorptionShare")).toMatchObject({ value: "0.111111111111", derivation: { numerator: "10" } });
    expect(a.reconciliations[1]).toMatchObject({ status: "unresolved", left: "104.956", right: "100", relativeDeltaDerivation: { numerator: "4.956", denominator: "100", rounding: "half-up", scale: 12 } });
    expect(metric(a, "executableUnwindCapacityUsd")).toMatchObject({ state: "unavailable" });
  });

  it("preserves high precision and covers undercollateralization, freshness, and repeated snapshots", () => {
    expect(buildF({ tvl: "100.000000000000000001", firstCell: "60.000000000000000001" }).breakdowns[0]!.entries.find((e) => e.key === "USDC")?.amountUsd).toBe("80.000000000000000001");
    expect(metric(buildF({ supply: "110" }), "reserveExcessPct")).toMatchObject({ value: "-9.090909090909" });
    expect(() => buildF({ snapshotDate: "1784500000" })).toThrow(/stale/);
    const retry = buildF(undefined, new Date("2026-07-22T20:06:00.000Z")), first = buildF();
    expect(retry.snapshotId).toBe(first.snapshotId); expect(() => valSet([first, retry])).toThrow(/Duplicate protocol API snapshot ID/);
  });

  it("enforces the Falcon TVL reconciliation tolerance boundary", () => {
    expect(() => buildF({ tvl: "100.01" })).not.toThrow();
    expect(() => buildF({ tvl: "100.0100000001" })).toThrow(/do not reconcile/);
    expect(() => buildF({ tvl: "20000000.02", firstCell: "19999960" })).not.toThrow();
    expect(() => buildF({ tvl: "20000000.020000001", firstCell: "19999960" })).toThrow(/do not reconcile/);
  });
});

describe("protocol API CLI policy", () => {
  const runCli = async (args: string[], cwd = process.cwd()) => {
    const logs: string[] = [], errs: string[] = [];
    const status = await runCliFn(args, { log: (m) => logs.push(m), error: (m) => errs.push(m) }, cwd);
    return { status, stdout: logs.join(""), stderr: errs.join("") };
  };

  it("accepts repeated canonical replays, sorts full time vectors newest first, and rejects noncanonical bytes", () => withTmp("pharos-protocol-api-test-", async (dir) => {
    const older = buildU(), newer = buildU({ statusTimestamp: "2026-07-22 20:01:16.250683 UTC" });
    expect(valSet([older, newer]).map((a) => a.snapshotId)).toEqual([newer.snapshotId, older.snapshotId]);
    const olderP = join(dir, "older.json"), newerP = join(dir, "newer.json"), nonP = join(dir, "noncanonical.json");
    writeFileSync(olderP, ser(older)); writeFileSync(newerP, ser(newer));
    const rep = runProtocolCli(["--replay", olderP, "--replay", newerP], dir);
    expect(rep.status, rep.stderr).toBe(0); expect(rep.stdout).toContain(olderP); expect(rep.stdout).toContain(newerP);
    writeFileSync(nonP, js(older, null, 2));
    const nc = await runCli(["--replay", nonP], dir);
    expect(nc.status).toBe(1); expect(nc.stderr).toMatch(/not canonical/);
  }));

  it("checks legacy summary and body fingerprints independently at the designated path", () => withTmp("pharos-legacy-protocol-api-test-", async (dir) => {
    const sumP = LEGACY.replace(/\.json$/, ".summary.json"), frozen = JSON.parse(readFileSync(sumP, "utf8"));
    try {
      mkdirSync(dirname(join(dir, LEGACY)), { recursive: true });
      const localSum = join(dir, sumP); writeFileSync(localSum, js(frozen));
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      const unav = await runCli(["--replay", LEGACY], dir);
      expect(unav.status).toBe(1); expect(unav.stderr).toMatch(/frozen-V1-metadata=true/);
      expect(unav.stdout).toContain("0 hash-verified normalized-only V1 artifact(s), 1 unavailable artifact(s)");
      writeFileSync(localSum, js({ ...frozen, sha256: "0".repeat(64) }));
      const chSum = await runCli(["--replay", LEGACY], dir); expect(chSum.status).toBe(1); expect(chSum.stderr).toMatch(/Unknown or modified legacy protocol API artifact/);
      writeFileSync(localSum, js(frozen)); writeFileSync(join(dir, LEGACY), js({ schemaVersion: 1, kind: "protocol-api-mechanism-measurement" }));
      const chBody = await runCli(["--replay", LEGACY], dir); expect(chBody.status).toBe(1); expect(chBody.stderr).toMatch(/Unknown or modified legacy protocol API artifact/);
    } finally { vi.unstubAllEnvs(); }
  }));

  it("accepts the frozen legacy V1 bytes only at their designated path", () => withTmp("pharos-legacy-protocol-api-bytes-", async (dir) => {
    const frozen = readFileSync(join(__dirname, "fixtures", "usde-ethena-frozen-legacy-protocol-api-v1.json"));
    expect(createHash("sha256").update(frozen).digest("hex")).toBe("cdcbc2f806fcf6def97a2870d262a821ece9636efcd5a9d80c29518ae1a2589f");
    mkdirSync(dirname(join(dir, LEGACY)), { recursive: true }); writeFileSync(join(dir, LEGACY), frozen);
    const acc = await runCli(["--replay", LEGACY], dir);
    expect(acc.status, acc.stderr).toBe(0); expect(acc.stdout).toMatch(/frozen legacy V1 original-byte fingerprint passed/);
    const moved = LEGACY.replace("2026-07-22T20-00-16.250Z", "2026-07-22T21-00-16.250Z");
    writeFileSync(join(dir, moved), frozen);
    const mis = await runCli(["--replay", moved], dir);
    expect(mis.status).toBe(1); expect(mis.stderr).toMatch(/Unknown or modified legacy protocol API artifact/);
  }));

  it("keeps replay-all scoped to protocol API refresh target directories", () => withTmp("pharos-protocol-discovery-", async (dir) => {
    const root = join(dir, "shared/data/safety-score-v9/mechanism-measurements"), tgt = join(root, "usde-ethena"), unr = join(root, "iusd-infinifi");
    mkdirSync(tgt, { recursive: true }); mkdirSync(unr);
    const a = buildU(), aPath = join(tgt, artFile(a));
    writeFileSync(aPath, ser(a)); writeFileSync(join(unr, "invalid-protocol-api.json"), "{invalid unrelated artifact");
    const acc = await runCli(["--replay-all"], dir);
    expect(acc.status, acc.stderr).toBe(0); expect(acc.stdout).toContain("1 verified V2 artifact(s), 0 hash-verified normalized-only V1 artifact(s), 0 unavailable artifact(s)");
    writeFileSync(aPath, js(a, null, 2));
    const cor = await runCli(["--replay-all"], dir);
    expect(cor.status).toBe(1); expect(cor.stderr).toContain(aPath); expect(cor.stderr).toMatch(/not canonical/);
  }));

  it("counts mixed verified V2, hash-verified V1 and unavailable V2 without claiming success", () => withTmp("pharos-protocol-mixed-", async (dir) => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    try {
      const root = "shared/data/safety-score-v9/mechanism-measurements";
      mkdirSync(dirname(join(dir, LEGACY)), { recursive: true });
      writeFileSync(join(dir, LEGACY), readFileSync(join(__dirname, "fixtures/usde-ethena-frozen-legacy-protocol-api-v1.json")));
      const a = buildU(); writeFileSync(join(dir, root, "usde-ethena", artFile(a)), ser(a));
      const un = buildF(), unP = join(dir, root, "usdf-falcon", artFile(un));
      mkdirSync(dirname(unP), { recursive: true }); writeFileSync(sumPath(unP), js(buildSum(Buffer.from(ser(un)), unP, dir)));
      const r = await runCli(["--replay-all"], dir);
      expect(r.status).toBe(1); expect(r.stdout).toContain("replay-all incomplete: 1 verified V2 artifact(s), 1 hash-verified normalized-only V1 artifact(s), 1 unavailable artifact(s)");
      expect(r.stdout).not.toContain("replay-all passed"); expect(r.stderr).toContain("schema=2"); expect(r.stderr).toContain("Missing CLOUDFLARE_ACCOUNT_ID");
    } finally { vi.unstubAllEnvs(); }
  }));

  it("hash-checks cached and R2 original bytes before reporting archive verification", () => withTmp("pharos-protocol-readback-", async (dir) => {
    const a = buildF(), bytes = Buffer.from(ser(a)), path = join(dir, "artifact-protocol-api.json"), sum = buildSum(bytes, path, dir);
    writeFileSync(sumPath(path), js(sum));
    const cacheP = join(dir, "agents/.cache/measurements", `${sum.sha256}.json`), pinned = sum.r2Key.replace(/^captures\//, "pinned/");
    type R2C = NonNullable<Parameters<typeof readArt>[1]>;
    const mkC = (fn: R2C["get"]) => ({ get: vi.fn<R2C["get"]>(fn), put: vi.fn<R2C["put"]>(), head: vi.fn<R2C["head"]>() });
    const miss = mkC(async () => null);
    expect(await readArt(path, miss, dir)).toMatchObject({ status: "unavailable", schemaVersion: 2, reason: expect.stringContaining("expired: non-replayable") });
    expect(miss.get.mock.calls.map(([k]) => k)).toEqual([pinned, sum.r2Key]);
    expect(await readArt(path, mkC(async () => Buffer.from("corrupt")), dir)).toMatchObject({ status: "unavailable", schemaVersion: 2, reason: expect.stringContaining("integrity mismatch") });
    const cl = mkC(async () => bytes);
    expect(await readArt(path, cl, dir)).toMatchObject({ status: "verified-v2", artifact: a });
    expect(cl.get).toHaveBeenCalledWith(pinned); expect(readFileSync(cacheP)).toEqual(bytes);
    cl.get.mockClear(); expect(await readArt(path, cl, dir)).toMatchObject({ status: "verified-v2" }); expect(cl.get).not.toHaveBeenCalled();
    writeFileSync(cacheP, "corrupt");
    expect(await readArt(path, cl, dir)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("integrity mismatch") }); expect(cl.get).not.toHaveBeenCalled();
  }));
});
