import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import * as hashing from "../../../lib/hash";
import { runAdapter, installAdapterNetwork } from "./reserve-adapter.test-support";

const MAIN_URL = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.D_i7a3kT.mjs";
const MAIN_HASH = "dc110f38af882dbf6e9c30d28a6d19c2c82c20db3d66fe2b176f777790efa0a8";
const CASES = [
  { product: "PYUSD", id: "pyusd-paypal", module: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.DpyEhRBZ.mjs", hash: "dc493daae50ebfca7b9f72b0e1ad58ec8c145efeb4ef877a59edbb6938953f1b", assets: 2893935877, liabilities: 2886948845, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo", "treasury-bill"] },
  { product: "USDG", id: "usdg-paxos", module: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.BQTNeiYP.mjs", hash: "8a660eb848157b89907a5169273c93b606ddc064d6e872206ba1675b7ebd3871", assets: 3350462467, liabilities: 3340650602, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "money-market-fund", "treasury-bill"] },
  { product: "USDP", id: "usdp-paxos", module: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.BTKrwKJ5.mjs", hash: "d6b68b23e6d1734690cba1ca5ff2218012ac929f5159ce0c1ec0e4e921e8bb26", assets: 29189905, liabilities: 29168261, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo"] },
] as const;

describe("Paxos fiat product assurance", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(CASES)("$product selects its reviewed report, reconciles every liability and rejects module drift", async (row) => {
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
    const network = installAdapterNetwork({
      html: {
        [manifest.officialIndexUrl]: `<script src="${MAIN_URL}"></script>`,
        [MAIN_URL]: main,
        [new URL(row.module, MAIN_URL).href]: () => drift ? `${page} changed` : page,
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
    drift = true;
    await expect(runAdapter("paxos-independent-assurance", row.id, {
      network,
      nowSec: Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000),
      validate: false,
    })).rejects.toThrow("website module changed");
  });
});
