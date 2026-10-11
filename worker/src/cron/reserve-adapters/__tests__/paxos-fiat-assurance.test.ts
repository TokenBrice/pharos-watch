import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import * as hashing from "../../../lib/hash";
import { runAdapter, installAdapterNetwork } from "./reserve-adapter.test-support";

const MAIN_URL = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.Dqj4xIMw.mjs";
const MAIN_HASH = "935fe139f26e366df456d4ee8443db234943ec239141c7ae902ac0c57e0f69d2";
const CASES = [
  { product: "PYUSD", id: "pyusd-paypal", module: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.DczhKAwI.mjs", hash: "c1c89a0f938029835577261a3564a8332145730c69481adaf58dfddc216539be", assets: 2893935877, liabilities: 2886948845, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo", "treasury-bill"] },
  { product: "USDG", id: "usdg-paxos", module: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.DgZ5PRKp.mjs", hash: "df4971f85fffad41a1819c5d02c53263bfa36efdef73af06104bf105184171bc", assets: 3350462467, liabilities: 3340650602, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "money-market-fund", "treasury-bill"] },
  { product: "USDP", id: "usdp-paxos", module: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.DsxIJrQO.mjs", hash: "bd27e5973cf8f92bf3d56dc981ef7a9e1fd23ffe18b5d5e8863d6aa5f5520fa2", assets: 29189905, liabilities: 29168261, asOf: "2026-08-31T17:00:00-04:00", classes: ["bank-deposit", "repo"] },
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
