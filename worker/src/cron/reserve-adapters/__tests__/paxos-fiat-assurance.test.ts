import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import * as hashing from "../../../lib/hash";
import { fetchPaxosIndependentAssuranceReserves } from "../paxos-independent-assurance";

const MAIN_URL = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.DbHh1PDb.mjs";
const MAIN_HASH = "75246095328cd57d84ba6056ca26adcef441670acb707fbf6c58c2397c8af29d";
const CASES = [
  { product: "PYUSD", id: "pyusd-paypal", module: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.DPlGCIc7.mjs", hash: "fca65a645929e70fb165e668ec2444d1559f80dd4b41e95e9e961e3173ba8aa0", assets: 2694072163, liabilities: 2689335674, classes: ["bank-deposit", "repo", "treasury-bill"] },
  { product: "USDG", id: "usdg-paxos", module: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.D1Y29jmu.mjs", hash: "270af48d9514722e5bc79ae59231604a58efe274eb29b675e648a6c2d4dfc2c5", assets: 3404876225, liabilities: 3400474143, classes: ["bank-deposit", "money-market-fund", "treasury-bill"] },
  { product: "USDP", id: "usdp-paxos", module: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.Gwv0nhJV.mjs", hash: "9dcaa30b067fa4f2b7f25abdbf5f48d7e9ff927e7a6e2585120625840626195f", assets: 31975703, liabilities: 31954027, classes: ["bank-deposit", "repo"] },
] as const;

describe("Paxos fiat product assurance", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(CASES)("$product selects its reviewed report, reconciles every liability and rejects module drift", async (row) => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === row.id)!;
    const original = assurance.getIndependentAssuranceManifest(row.product);
    const pdf = "%PDF-1.7 scoped assurance fixture";
    const manifest = { ...original, reportByteLength: pdf.length, reportSha256: createHash("sha256").update(pdf).digest("hex") };
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(manifest);
    const main = "reviewed main route";
    // Historical base report precedes the reviewed override: first-PDF selection must not win.
    const page = `file:\`https://framerusercontent.com/assets/U6CdEPIqt3a6rt4lA2aNl149M.pdf\`,variant:{file:\`${manifest.reportUrl}\`}`;
    const sha256 = hashing.sha256Hex;
    vi.spyOn(hashing, "sha256Hex").mockImplementation(async (body) => body === main ? MAIN_HASH : body === page ? row.hash : sha256(body));
    let drift = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: string;
      if (url === manifest.officialIndexUrl) body = `<script src="${MAIN_URL}"></script>`;
      else if (url === MAIN_URL) body = main;
      else if (url === new URL(row.module, MAIN_URL).href) body = drift ? `${page} changed` : page;
      else if (url === manifest.reportUrl) body = pdf;
      else throw new Error(`Unreviewed report or route requested: ${url}`);
      const response = new Response(body);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }));
    const result = await fetchPaxosIndependentAssuranceReserves(coin, coin.liveReservesConfig!, AbortSignal.timeout(5000));
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(row.assets / row.liabilities, 12);
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-07-31T17:00:00-04:00") / 1000);
    expect(result.slices.map((slice) => slice.assetClass).sort()).toEqual([...row.classes].sort());
    expect(() => assurance.reconcileIndependentAssuranceManifest({
      ...original, liabilities: original.liabilities.map((liability, index) => index === 0 ? { ...liability, amount: String(Number(liability.amount) - 1) } : liability),
    })).toThrow(/liability total/);
    drift = true;
    await expect(fetchPaxosIndependentAssuranceReserves(coin, coin.liveReservesConfig!, AbortSignal.timeout(5000))).rejects.toThrow("website module changed");
  });
});
