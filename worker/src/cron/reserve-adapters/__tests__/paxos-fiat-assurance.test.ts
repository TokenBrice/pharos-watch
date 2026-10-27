import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import { runAdapter, installAdapterNetwork } from "./reserve-adapter.test-support";

const SITE = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl";
const MAIN_URL = `${SITE}/script_main.DWSgnPFN.mjs`;
const CASES = [
  { product: "PYUSD", id: "pyusd-paypal", module: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.eF7UdfG3.mjs", capture: "2026-10-27", now: "2026-10-27T00:00:00Z", assets: 2754709360, liabilities: 2747625868, asOf: "2026-09-30T17:00:00-04:00", classes: ["bank-deposit", "repo", "treasury-bill"] },
  { product: "USDG", id: "usdg-paxos", module: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.1zoiA1Sy.mjs", capture: "2026-10-24", now: "2026-10-24T00:00:00Z", assets: 3168423407, liabilities: 3164996248, asOf: "2026-09-30T17:00:00-04:00", classes: ["bank-deposit", "money-market-fund", "treasury-bill"] },
  { product: "USDP", id: "usdp-paxos", module: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.xspL-Gtt.mjs", capture: "2026-10-27", now: "2026-10-27T00:00:00Z", assets: 26113649, liabilities: 26084307, asOf: "2026-09-30T17:00:00-04:00", classes: ["bank-deposit", "repo"] },
] as const;
const routeTableMain = (row: (typeof CASES)[number]) =>
  `const routes={R1:{elements:{a:\`${row.product.toLowerCase()}-attestations\`},page:L(()=>import(\`./${row.module}\`)),path:\`/${row.product.toLowerCase()}-transparency\`},`
  + `R2:{page:L(()=>import(\`./decoyPage.D1coyChunk.mjs\`)),path:\`/blog\`}};`;
function fixture(product: string, captured = "2026-10-27"): string {
  const capture: { gzipBase64: string; rawSha256: string; rawByteLength: number } = JSON.parse(
    readFileSync(new NodeURL(`./fixtures/paxos/${product.toLowerCase()}-${captured}.module.json`, import.meta.url), "utf8"),
  );
  const bytes = gunzipSync(Buffer.from(capture.gzipBase64, "base64"));
  expect(bytes.byteLength).toBe(capture.rawByteLength);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.rawSha256);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

describe("Paxos fiat product assurance", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(CASES)("$product admits the reviewed selection, reconciles liabilities and degrades on a newer report", async (row) => {
    const original = assurance.getIndependentAssuranceManifest(row.product);
    const pdf = "%PDF-1.7 scoped assurance fixture";
    const manifest = { ...original, reportByteLength: pdf.length, reportSha256: createHash("sha256").update(pdf).digest("hex") };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    const page = fixture(row.product, row.capture);
    const nextModule = row.module.replace(/\.[^.]+\.mjs$/, ".SeptemberChunk.mjs");
    let changed = false;
    const newerPage = page.replace("\n//# sourceMappingURL=", "\nconst september={file:`https://framerusercontent.com/assets/September2026Unreviewed.pdf`};\n//# sourceMappingURL=");
    expect(newerPage).not.toBe(page);
    expect(newerPage).toContain(manifest.reportUrl);
    const network = installAdapterNetwork({
      html: {
        [manifest.officialIndexUrl]: `<script src="${MAIN_URL}"></script>`,
        [MAIN_URL]: () => routeTableMain(row).replace(row.module, changed ? nextModule : row.module),
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
    const row = CASES[0];
    const network = installAdapterNetwork({
      html: {
        [manifest.officialIndexUrl]: `<script src="${MAIN_URL}"></script>`,
        [MAIN_URL]: routeTableMain(row),
        [new URL(row.module, MAIN_URL).href]: fixture("PYUSD"),
        [manifest.reportUrl]: { body: tampered, headers: { "content-type": "application/pdf" } },
      },
    });
    await expect(runAdapter("paxos-independent-assurance", row.id, {
      network, nowSec: Math.floor(Date.parse("2026-10-27T00:00:00Z") / 1000), validate: false,
    })).rejects.toThrow(gate === "length" ? "PDF byte length" : "PDF SHA-256");
  });
});
