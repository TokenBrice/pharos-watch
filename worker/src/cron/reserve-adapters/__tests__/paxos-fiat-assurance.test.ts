import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import { runAdapter, installAdapterNetwork } from "./reserve-adapter.test-support";

const SITE = "https://framerusercontent.com/sites/3LisDBBNdK504GXe51PoGF";
const MAIN_URL = `${SITE}/script_main.JHWnvNrQ.mjs`;
const CASES = [
  { product: "PAXG", id: "paxg-paxos", module: "XxY0esLV2L37QMcfpTbY3mX7rJ1xD_tTnPI8cztHho0.DCYmf5Zw.mjs", capture: "2026-10-27", now: "2026-10-27T00:00:00Z", assets: 435306, liabilities: 435306, asOf: "2026-09-30T17:00:00-04:00", classes: ["commodity-allocated"] },
  { product: "PYUSD", id: "pyusd-paypal", module: "hvQ2ClCUy80JuCQ8DW0rPlTdwALgwC46CwKznbqVAT0.CPA3W5Z-.mjs", capture: "2026-10-27", now: "2026-10-27T00:00:00Z", assets: 2754709360, liabilities: 2747625868, asOf: "2026-09-30T17:00:00-04:00", classes: ["bank-deposit", "repo", "treasury-bill"] },
  { product: "USDG", id: "usdg-paxos", module: "DIAUvcXOB9nOYLw3a2fyfs-NJgh1Sht8DtgV4mAgIZY.adp0H3P0.mjs", capture: "2026-10-24", now: "2026-10-24T00:00:00Z", assets: 3168423407, liabilities: 3164996248, asOf: "2026-09-30T17:00:00-04:00", classes: ["bank-deposit", "money-market-fund", "treasury-bill"] },
  { product: "USDP", id: "usdp-paxos", module: "pa_gfhekxTj99VUC6AmRAHCHBeVfp34Y82lKPKjcwRM.BBCIx3bI.mjs", capture: "2026-10-27", now: "2026-10-27T00:00:00Z", assets: 26113649, liabilities: 26084307, asOf: "2026-09-30T17:00:00-04:00", classes: ["bank-deposit", "repo"] },
] as const;
const MIGRATED_MAIN = readFileSync(new NodeURL("./fixtures/paxos/main-2026-11-04.mjs.txt", import.meta.url), "utf8")
  .replace(/^<!--[^]*?-->\s*/, "");
function fixture(product: string, captured = "2026-10-27"): string {
  if (product === "PAXG") return readFileSync(new NodeURL("./fixtures/paxos/reports-2026-11-04.mjs.txt", import.meta.url), "utf8")
    .replace(/^<!--[^]*?-->\s*/, "");
  const capture: { gzipBase64: string; rawSha256: string; rawByteLength: number } = JSON.parse(
    readFileSync(new NodeURL(`./fixtures/paxos/${product.toLowerCase()}-${captured}.module.json`, import.meta.url), "utf8"),
  );
  const bytes = gunzipSync(Buffer.from(capture.gzipBase64, "base64"));
  expect(bytes.byteLength).toBe(capture.rawByteLength);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.rawSha256);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

describe("Paxos product assurance", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(CASES)("$product admits the reviewed selection, reconciles liabilities and degrades on a newer report", async (row) => {
    const original = assurance.getIndependentAssuranceManifest(row.product);
    const pdf = "%PDF-1.7 scoped assurance fixture";
    const manifest = { ...original, reportByteLength: pdf.length, reportSha256: createHash("sha256").update(pdf).digest("hex") };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    const page = fixture(row.product, row.capture);
    const nextModule = row.module.replace(/\.[^.]+\.mjs$/, ".SeptemberChunk.mjs");
    let changed = false;
    const newerPage = `${page}\nconst september={file:\`https://framerusercontent.com/assets/September2026Unreviewed.pdf\`};`;
    expect(newerPage).not.toBe(page);
    expect(newerPage).toContain(manifest.reportUrl);
    const network = installAdapterNetwork({
      html: {
        [manifest.officialIndexUrl]: `<script src="${MAIN_URL}"></script>`,
        [MAIN_URL]: () => MIGRATED_MAIN.replace(row.module, changed ? nextModule : row.module),
        [new URL(row.module, MAIN_URL).href]: page,
        [new URL(nextModule, MAIN_URL).href]: newerPage,
        [manifest.reportUrl]: { body: pdf, headers: { "content-type": "application/pdf" } },
      },
    });
    const nowSec = Math.floor(Date.parse(row.now) / 1000);
    const { result } = await runAdapter("paxos-independent-assurance", row.id, { network, nowSec });
    expect(result.warnings?.some((warning) => warning.code === "newer-unreviewed-report")).not.toBe(true);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(row.assets / row.liabilities, 12);
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse(row.asOf) / 1000);
    expect(result.slices.map((slice) => slice.assetClass).sort()).toEqual([...row.classes].sort());
    expect(() => assurance.reconcileIndependentAssuranceManifest({
      ...original, liabilities: original.liabilities.map((liability, index) => index === 0 ? { ...liability, amount: String(Number(liability.amount) - 1) } : liability),
    })).toThrow(/liability total/);
    changed = true;
    const { result: newer } = await runAdapter("paxos-independent-assurance", row.id, { network, nowSec });
    expect(newer.slices).toEqual(result.slices);
    expect(newer.metadata?.sourceTimestamp).toBe(result.metadata?.sourceTimestamp);
    expect(newer.warnings).toContainEqual(expect.objectContaining({
      code: "newer-unreviewed-report",
      effect: "degraded",
      message: expect.stringContaining("https://framerusercontent.com/assets/September2026Unreviewed.pdf"),
    }));
  });

  it.each(["length", "SHA-256"] as const)("retains the manifest PDF %s gate after page verification", async (gate) => {
    const pdf = "%PDF-1.7 scoped assurance fixture";
    const tampered = `${pdf} `;
    const original = assurance.getIndependentAssuranceManifest("PYUSD");
    const manifest = {
      ...original,
      reportByteLength: gate === "length" ? pdf.length : tampered.length,
      reportSha256: createHash("sha256").update(pdf).digest("hex"),
    };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    const row = CASES[1];
    const network = installAdapterNetwork({
      html: {
        [manifest.officialIndexUrl]: `<script src="${MAIN_URL}"></script>`,
        [MAIN_URL]: MIGRATED_MAIN,
        [new URL(row.module, MAIN_URL).href]: fixture("PYUSD"),
        [manifest.reportUrl]: { body: tampered, headers: { "content-type": "application/pdf" } },
      },
    });
    await expect(runAdapter("paxos-independent-assurance", row.id, {
      network, nowSec: Math.floor(Date.parse("2026-10-27T00:00:00Z") / 1000), validate: false,
    })).rejects.toThrow(gate === "length" ? "PDF byte length" : "PDF SHA-256");
  });
});
