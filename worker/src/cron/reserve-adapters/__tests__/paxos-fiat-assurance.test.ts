import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import * as hashing from "../../../lib/hash";
import { runAdapter, installAdapterNetwork } from "./reserve-adapter.test-support";

const MAIN_URL = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.DZqMDh2_.mjs";
const MAIN_HASH = "0dc7d49c276343e5b721362a348ee66f8f82a0bddd1bd7aecbaabfa19345929c";
const CASES = [
  { product: "PYUSD", id: "pyusd-paypal", module: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.BCm9jGCp.mjs", hash: "ee68ebb1cbfee024d2e40c4d39f121b9f3c4380e0bed3b2c04cca2a213fe3a5e", assets: 2893935877, liabilities: 2886948845, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo", "treasury-bill"] },
  { product: "USDG", id: "usdg-paxos", module: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.DBmYnQbz.mjs", hash: "bbd62029d8cb0f280869d6c7104d6365b648ac1e8b59c2385b93808249294828", assets: 3350462467, liabilities: 3340650602, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "money-market-fund", "treasury-bill"] },
  { product: "USDP", id: "usdp-paxos", module: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.BLSMgw0g.mjs", hash: "f68141e0ca591cb1083f43b3ff71a04b607643d423b6ead7a6974a7097e07be9", assets: 29189905, liabilities: 29168261, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo"] },
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
