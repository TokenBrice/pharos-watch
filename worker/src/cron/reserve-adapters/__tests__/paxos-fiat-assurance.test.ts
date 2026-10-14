import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import { runAdapter, installAdapterNetwork } from "./reserve-adapter.test-support";

const SITE = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl";
// The main-module filename is discovered from the served index each run; it is
// intentionally not pinned (Framer renames it on every redeploy).
const MAIN_URL = `${SITE}/script_main.DWSgnPFN.mjs`;
const CASES = [
  { product: "PYUSD", id: "pyusd-paypal", module: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.BCm9jGCp.mjs", assets: 2893935877, liabilities: 2886948845, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo", "treasury-bill"] },
  { product: "USDG", id: "usdg-paxos", module: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.DBmYnQbz.mjs", assets: 3350462467, liabilities: 3340650602, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "money-market-fund", "treasury-bill"] },
  { product: "USDP", id: "usdp-paxos", module: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.BLSMgw0g.mjs", assets: 29189905, liabilities: 29168261, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo"] },
] as const;

/** Route-table excerpt shaped like the live Framer main module: every route
 * entry binds exactly one dynamic page import. The decoy route proves the
 * product route is selected by its path, not by import order. */
const routeTableMain = (row: (typeof CASES)[number]) =>
  `R1:{elements:{a:\`${row.product.toLowerCase()}-attestations\`},page:L(()=>import(\`./${row.module}\`)),path:\`/${row.product.toLowerCase()}-transparency\`},`
  + `R2:{page:L(()=>import(\`./decoyPage.D1coyChunk.mjs\`)),path:\`/blog\`}`;

const reviewedManifest = (pdf: string) => {
  const original = assurance.getIndependentAssuranceManifest("PYUSD");
  return { ...original, reportByteLength: pdf.length, reportSha256: createHash("sha256").update(pdf).digest("hex") };
};

describe("Paxos fiat product assurance", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(CASES)("$product selects its reviewed report, reconciles every liability and rejects a re-published selection", async (row) => {
    const original = assurance.getIndependentAssuranceManifest(row.product);
    const pdf = "%PDF-1.7 scoped assurance fixture";
    const manifest = { ...original, reportByteLength: pdf.length, reportSha256: createHash("sha256").update(pdf).digest("hex") };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    // Historical base report precedes the reviewed override: first-PDF selection must not win.
    const page = `file:\`https://framerusercontent.com/assets/U6CdEPIqt3a6rt4lA2aNl149M.pdf\`,variant:{file:\`${manifest.reportUrl}\`}`;
    let newerReportPosted = false;
    const network = installAdapterNetwork({
      html: {
        [manifest.officialIndexUrl]: `<script src="${MAIN_URL}"></script>`,
        [MAIN_URL]: routeTableMain(row),
        [new URL(row.module, MAIN_URL).href]: () => newerReportPosted
          ? page.split(`file:\`${manifest.reportUrl}\``).join("file:`https://framerusercontent.com/assets/September2026Unreviewed.pdf`")
          : page,
        [manifest.reportUrl]: { body: pdf, headers: { "content-type": "application/pdf" } },
      },
    });
    const { result } = await runAdapter("paxos-independent-assurance", row.id, {
      network,
      nowSec: Math.floor(Date.parse("2026-09-25T00:00:00Z") / 1000),
    });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(row.assets / row.liabilities, 12);
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse(row.asOf) / 1000);
    expect(result.slices.map((slice) => slice.assetClass).sort()).toEqual([...row.classes].sort());
    expect(() => assurance.reconcileIndependentAssuranceManifest({
      ...original, liabilities: original.liabilities.map((liability, index) => index === 0 ? { ...liability, amount: String(Number(liability.amount) - 1) } : liability),
    })).toThrow(/liability total/);
    // A re-published page whose selection drops the reviewed report fails closed with a typed reason.
    newerReportPosted = true;
    await expect(runAdapter("paxos-independent-assurance", row.id, {
      network,
      nowSec: Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000),
      validate: false,
    })).rejects.toThrow("paxos-independent-assurance: report-binding-missing");
  });

  it("still enforces the manifest PDF SHA-256 after durable discovery", async () => {
    const pdf = "%PDF-1.7 scoped assurance fixture";
    const tampered = "%PDF-1.7 scoped assurance fixture ";
    // Reviewed byte length matches the served bytes; only the hash is wrong.
    const manifest = { ...reviewedManifest(pdf), reportByteLength: tampered.length };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    const row = CASES[0];
    const network = installAdapterNetwork({
      html: {
        [manifest.officialIndexUrl]: `<script src="${MAIN_URL}"></script>`,
        [MAIN_URL]: routeTableMain(row),
        [new URL(row.module, MAIN_URL).href]: `file:\`${manifest.reportUrl}\``,
        [manifest.reportUrl]: { body: tampered, headers: { "content-type": "application/pdf" } },
      },
    });
    await expect(runAdapter("paxos-independent-assurance", row.id, {
      network,
      nowSec: Math.floor(Date.parse("2026-09-25T00:00:00Z") / 1000),
      validate: false,
    })).rejects.toThrow("PDF SHA-256");
  });
});
