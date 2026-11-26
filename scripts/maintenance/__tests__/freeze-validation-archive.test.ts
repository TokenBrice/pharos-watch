import { expect, it } from "vitest";
import { R2ObjectExistsError } from "../../lib/r2-object-client";
import * as archive from "../freeze-validation-archive";
import {
  cexFetch, createEnv, createRollEnv, DAY, EMPTY_SPECS, emptyFetch, EXPECTED_MATRIX_LISTED,
  jsonFetch, malformedCatalogFetch, MATRIX_SPECS, NOW, PREFIX, readJson, validFetch,
} from "./fixtures/freeze-validation-archive-fixtures";

it("preserves unassessed cohorts and tracked-source invariants", () => {
  expect(archive.classifyPreCliffCohorts([{ id: "a", mica: { status: "authorized" } }], ["b", "a"])).toEqual([
    { id: "a", mica: "authorized", genius: "unassessed" }, { id: "b", mica: "unassessed", genius: "unassessed" },
  ]);
  const { compliance, cohorts } = archive.loadActiveComplianceInputs();
  const { mica, genius } = archive.countPreCliffCohorts(cohorts);
  const n = compliance.length, sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b);
  expect([n > 0, new Set(cohorts.map((r) => r.id)).size, sum(mica), sum(genius)]).toEqual([true, n, n, n]);
  expect(cohorts.every((r, i) => (r.mica === "unassessed") === !compliance[i]!.mica && (r.genius === "unassessed") === !compliance[i]!.genius)).toBe(true);
});

it("enforces orderbook validity and strict R2 tri-state listed", async () => {
  const asks = [["1", "10"], ["1.02", "5"]], band = archive.measureOrderbookBand;
  expect(band([["1", "10"]], asks)).toMatchObject({ schemaOk: true, bidDepthTruncated: true, askDepthTruncated: false });
  expect(band([["1", "10"], ["bad", "5"]], asks)).toMatchObject({ schemaOk: false, bidDepthQuote1pct: null, reason: "malformed-bid-level" });
  expect(band([[true, "10"]], asks)).toMatchObject({ schemaOk: false, reason: "malformed-top-of-book" });
  expect(band([["0x1", "10"]], asks)).toMatchObject({ schemaOk: false, reason: "malformed-top-of-book" });
  expect(band([["1.05", "10"]], asks)).toMatchObject({ schemaOk: false, reason: "crossed-orderbook" });

  const listed = (rows: archive.MarketDepthRow[]) => rows.map((r) => [r.listed, r.unavailableReason]);
  expect(listed(await archive.collectGlobalOrderbooks(emptyFetch(), NOW, EMPTY_SPECS))).toEqual([
    [null, "coinbase-catalog-empty"], [null, "kraken-catalog-empty"],
  ]);
  expect(listed(await archive.collectGlobalOrderbooks(malformedCatalogFetch(), NOW, EMPTY_SPECS))).toEqual([
    [null, "coinbase-catalog-partially-malformed"], [null, "kraken-catalog-entry-malformed"],
  ]);
  const rows = await archive.collectGlobalOrderbooks(cexFetch(), NOW, MATRIX_SPECS);
  expect(rows[0]).toMatchObject({ bidDepthQuote1pct: 10, bidDepthUsd1pct: 11, fxRate: 1.1 });
  expect(listed(rows)).toEqual(EXPECTED_MATRIX_LISTED);
});

it("enforces conditional PUTs, origin-locked key, and baseline guards", async () => {
  const { r2, puts } = createEnv(), sealObj = archive.sealArchiveObject, key = `${PREFIX}a.gz`, body = Buffer.from("a"), reuse = { allowIdenticalReuse: true };
  await expect(sealObj(r2, "captures/x", body)).rejects.toThrow();
  expect([(await sealObj(r2, key, body, reuse)).reused, (await sealObj(r2, key, body, reuse)).reused, puts[0]]).toEqual([false, true, "*"]);
  await expect(sealObj(r2, key, Buffer.from("b"), reuse)).rejects.toThrow(/mismatch/);
  await expect(sealObj(r2, key, body)).rejects.toThrow(R2ObjectExistsError);

  const hdr = (u: string) => archive.buildPharosApiHeaders(u, { PHAROS_API_KEY: "k" })["X-API-Key"];
  expect([hdr("https://api.pharos.watch/api/peg-summary"), hdr("https://evil.example/api/peg-summary")]).toEqual(["k", undefined]);

  const missingStudy = createEnv({ fetch: validFetch({ omitStudyFields: true }) });
  expect([await missingStudy.seal(), missingStudy.puts.length]).toEqual([1, 0]);
  await expect(missingStudy.seal(DAY, "--api-base", "https://evil.example")).rejects.toThrow(/non-production/);
  await expect(missingStudy.seal(DAY, "--allow-partial")).rejects.toThrow(/canonical prefix/);
  await expect(createEnv({ now: () => new Date("2026-11-30T10:00Z") }).seal("2026-11-30", "--allow-partial", "--prefix", `${PREFIX}pre-cliff-2026-12/`)).rejects.toThrow(/canonical prefix/);
  await expect(missingStudy.run("baseline", "--date", DAY, "--dry-run", "--out", "agents/x.json")).rejects.toThrow();
  await expect(createEnv({ now: () => new Date("2027-01-09T10:00Z") }).seal("2027-01-09")).rejects.toThrow(/deadline/);
  await expect(createEnv({ checkDirtySealPaths: () => ["M coin.json"] }).seal()).rejects.toThrow(/uncommitted/);
});

it("verifies baselines and rejects bad gitSha, date, missing notice, or partial", async () => {
  const redirects: unknown[] = [];
  const keyOf = (p: string) => `${PREFIX}${p}/manifest.json`, env = createEnv({ fetch: validFetch({ onInit: (i) => redirects.push(i?.redirect) }) }), mKey = keyOf("pre-cliff-2026-12");
  expect([await env.seal(), env.jsonOut().apiBase, await env.verify(mKey), redirects.includes("error")]).toEqual([0, "https://api.pharos.watch", 0, true]);
  const sealed = readJson<archive.PreCliffBaselineManifest>(env.store, mKey);
  expect(sealed.regionalEligibility.map((o) => o.sourceId)).toContain("stablr-holder-notices");

  const noGit = createEnv({ r2: env.r2, readDesignDocAtGitRef: () => null });
  expect([await noGit.verify(mKey), noGit.rawOut().includes("design-doc-unverifiable-at-git-sha")]).toEqual([1, true]);

  env.store.set(keyOf("n"), Buffer.from(JSON.stringify({ ...sealed, objects: sealed.objects.filter((o) => !o.role.startsWith("regional-eligibility:")) })));
  expect([await env.verify(keyOf("n")), env.rawOut().includes("missing regionalEligibility object")]).toEqual([1, true]);

  const pKey = keyOf("p"), pEnv = createEnv({ fetch: jsonFetch(() => ({})) });
  expect([await pEnv.seal(DAY, "--allow-partial", "--prefix", `${PREFIX}p/`), await pEnv.verify(pKey), pEnv.rawOut().includes("partial-archive-not-complete"), await pEnv.verify(pKey, "--allow-partial")]).toEqual([0, 1, true, 0]);

  env.store.set(keyOf("b"), Buffer.from(JSON.stringify({ ...sealed, capturedAt: "2026-02-31T10:00:00Z" })));
  expect([await env.verify(keyOf("b")), env.rawOut().includes("malformed-manifest")]).toEqual([1, true]);
  await expect(env.run("verify", "--prefix", `${PREFIX}../captures/`)).rejects.toThrow();
});

it("enforces 30d retention, canonical partial guards, post-midnight recovery, and range resume", async () => {
  const gEnv = createEnv({ now: () => new Date("2026-12-10T23:00Z"), d1: { queryRaw: () => '[{"success":true,"results":[]}]' } });
  await expect(gEnv.roll("2026-12-10")).rejects.toThrow(/ended/);
  await expect(gEnv.roll("2026-11-01")).rejects.toThrow(/30-day/);
  await expect(gEnv.roll("2026-12-09", "--allow-partial")).rejects.toThrow(/canonical prefix/);
  await expect(gEnv.roll("2026-12-09", "--allow-partial", "--prefix", `${PREFIX}rolling/partial/`)).rejects.toThrow(/canonical prefix/);
  expect([await gEnv.roll("2026-12-09", "--local", "--allow-partial"), gEnv.jsonOut().forcedDryRunReason]).toEqual([0, "local-d1-target"]);

  const day = "2027-01-07", obs = "2027-01-08", { env, setNow } = createRollEnv(day, `${obs}T23:55Z`);
  await expect(env.roll(day)).rejects.toThrow(/manifest-put-interrupted/);
  const first = [...env.store.keys()].filter((k) => k.startsWith(`${PREFIX}rolling/markets/${obs}.`));
  expect(first).toHaveLength(1);

  // Retry after UTC midnight recovers the prior-day live markets + eligibility blobs cleanly.
  setNow("2027-01-09T00:20Z");
  const mKey = `${PREFIX}rolling/manifests/${day}.json`;
  expect([await env.roll(day), await env.verify(mKey)]).toEqual([0, 0]);
  const doc = readJson<archive.RollingDayManifest>(env.store, mKey);
  expect(doc).toMatchObject({ day, observedDate: obs, partial: false });
  expect(doc.objects.find((o) => o.role === "markets")?.r2Key).toBe(first[0]);
  expect(await env.run("roll", "--from", day, "--to", day)).toBe(0);
  expect((env.jsonOut().days as Array<{ alreadySealed?: boolean }>)[0]?.alreadySealed).toBe(true);
});
