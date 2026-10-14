import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import type { AdapterNetwork } from "./reserve-adapter.test-support";
import {
  PaxosDiscoveryError,
  verifyPaxosDiscovery,
  type PaxosDiscoveryFailureCode,
  type PaxosProductBinding,
} from "../paxos-independent-assurance";

const SITE = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl";
const MAIN_URL = `${SITE}/script_main.DWSgnPFN.mjs`;
const PAXG_ID = "9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU";
const PAXG_CHUNK = "Cm5Lb3KG";
const PAXG_MODULE_URL = `${SITE}/${PAXG_ID}.${PAXG_CHUNK}.mjs`;
const PAXG_REPORT_URL = getIndependentAssuranceManifest("PAXG").reportUrl;
const BINDING: PaxosProductBinding = {
  siteOrigin: SITE,
  routePath: "/paxg-transparency",
  pageModuleId: PAXG_ID,
};

const fixture = (name: string) => readFileSync(new NodeURL(`./fixtures/paxos/${name}`, import.meta.url), "utf8")
  .replace(/^<!--[^]*?-->\s*/, "");
const INDEX_HTML = fixture("index-2026-10-14.html");
const MAIN_MODULE = fixture("main-2026-10-14.mjs.txt");
const PAXG_MODULE = fixture("paxg-2026-10-14.mjs.txt");

function installFetch(html: Record<string, string | (() => string)> = {}): AdapterNetwork {
  return installAdapterNetwork({
    html: {
      [MAIN_URL]: MAIN_MODULE,
      [PAXG_MODULE_URL]: PAXG_MODULE,
      ...html,
    },
  });
}

const discover = (html: string, binding: PaxosProductBinding = BINDING) =>
  verifyPaxosDiscovery(html, binding, PAXG_REPORT_URL, AbortSignal.timeout(2000));

async function expectFailure(promise: Promise<string>, code: PaxosDiscoveryFailureCode): Promise<PaxosDiscoveryError> {
  const error = await promise.then(
    () => { throw new Error(`expected discovery to reject with ${code}`); },
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(PaxosDiscoveryError);
  expect((error as PaxosDiscoveryError).code).toBe(code);
  expect((error as PaxosDiscoveryError).message).toContain("paxos-independent-assurance:");
  return error as PaxosDiscoveryError;
}

describe("Paxos durable Framer discovery", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("accepts the October 14 live redeploy end to end", async () => {
    const network = installFetch();
    await expect(discover(INDEX_HTML)).resolves.toBe(PAXG_MODULE);
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("accepts a redeploy that renames the hashed main and page chunk filenames with identical semantics", async () => {
    const renamedMainUrl = `${SITE}/script_main.Zq9PinnedOut.mjs`;
    const renamedPageUrl = `${SITE}/${PAXG_ID}.Xw2Renamed.mjs`;
    const html = INDEX_HTML.replace("script_main.DWSgnPFN.mjs", "script_main.Zq9PinnedOut.mjs");
    const main = MAIN_MODULE
      .replace("script_main.DWSgnPFN.mjs.map", "script_main.Zq9PinnedOut.mjs.map")
      .replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs`, `${PAXG_ID}.Xw2Renamed.mjs`);
    const page = PAXG_MODULE.replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs.map`, `${PAXG_ID}.Xw2Renamed.mjs.map`);
    const network = installAdapterNetwork({
      html: { [renamedMainUrl]: main, [renamedPageUrl]: page },
    });
    await expect(discover(html)).resolves.toBe(page);
    expect(network.requests.map((request) => request.url)).toEqual([renamedMainUrl, renamedPageUrl]);
  });

  it.each([
    ["duplicated identical tag", INDEX_HTML + INDEX_HTML.replace(/^<!--[^]*?-->\s*/, "")],
    ["two different modules", INDEX_HTML.replace("DWSgnPFN", "SecondMod") + INDEX_HTML.replace(/^<!--[^]*?-->\s*/, "").replace("DWSgnPFN", "OtherMod")],
  ])("rejects an ambiguous main module (%s)", async (_label, html) => {
    const network = installFetch();
    await expectFailure(discover(html), "main-module-ambiguous");
    expect(network.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an index without any main module", async () => {
    const network = installFetch();
    await expectFailure(discover("<!doctype html><html><body>no scripts</body></html>"), "main-module-missing");
    expect(network.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a main module served outside the reviewed Framer site", async () => {
    const network = installFetch();
    await expectFailure(discover(INDEX_HTML.replace(SITE, "https://evil.example.com/sites/3XxgTiMfDKU2yZKNfef9sl")), "main-module-origin-drifted");
    expect(network.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects the official route re-pointed at an unreviewed page module", async () => {
    const main = MAIN_MODULE.replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs`, `UnreviewedPageIdentity.${PAXG_CHUNK}.mjs`);
    const network = installAdapterNetwork({
      html: { [MAIN_URL]: main, [`${SITE}/UnreviewedPageIdentity.${PAXG_CHUNK}.mjs`]: PAXG_MODULE },
    });
    const error = await expectFailure(discover(INDEX_HTML), "page-module-identity-drifted");
    expect(error.message).toContain("UnreviewedPageIdentity");
    // Only the main module is fetched before the identity gate rejects.
    expect(network.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects when the official route disappears from the route table", async () => {
    installFetch({ [MAIN_URL]: MAIN_MODULE.replace("path:`/paxg-transparency`", "path:`/paxg-attestations-archive`") });
    await expectFailure(discover(INDEX_HTML), "route-binding-missing");
  });

  it("rejects two page modules bound to the official route", async () => {
    installFetch({
      [MAIN_URL]: MAIN_MODULE.replace(
        "path:`/paxg-transparency`}",
        "path:`/paxg-transparency`},Second:{page:L(()=>import(`./9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU.C0ntender.mjs`)),path:`/paxg-transparency`}",
      ),
    });
    await expectFailure(discover(INDEX_HTML), "route-binding-ambiguous");
  });

  it("rejects a route table it cannot fully bind", async () => {
    installFetch({ [MAIN_URL]: `${MAIN_MODULE}\npath:\`/unrecognized-shape\`` });
    await expectFailure(discover(INDEX_HTML), "route-table-unrecognized");
  });

  it("rejects a product page that no longer binds the reviewed report", async () => {
    const replaced = PAXG_MODULE.split(`file:\`${PAXG_REPORT_URL}\``).join("file:`https://framerusercontent.com/assets/SeptemberUnreviewed.pdf`");
    expect(replaced).not.toContain(PAXG_REPORT_URL);
    const network = installAdapterNetwork({ html: { [MAIN_URL]: MAIN_MODULE, [PAXG_MODULE_URL]: replaced } });
    const error = await expectFailure(discover(INDEX_HTML), "report-binding-missing");
    expect(error.message).toContain(PAXG_REPORT_URL);
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects main and page module redirects", async () => {
    installAdapterNetwork({
      html: {
        [MAIN_URL]: { body: MAIN_MODULE, url: `${MAIN_URL}.redirected` },
        [PAXG_MODULE_URL]: PAXG_MODULE,
      },
    });
    await expectFailure(discover(INDEX_HTML), "main-module-response-drifted");

    installAdapterNetwork({
      html: {
        [MAIN_URL]: MAIN_MODULE,
        [PAXG_MODULE_URL]: { body: PAXG_MODULE, url: `${PAXG_MODULE_URL}.redirected` },
      },
    });
    await expectFailure(discover(INDEX_HTML), "page-module-response-drifted");
  });

  it("reconciles every native chain to gold ounces and rejects an omitted Solana liability", () => {
    const manifest = getIndependentAssuranceManifest("PAXG");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "431313", liabilityTotal: "431313", collateralizationRatio: 1,
    });
    expect(manifest.liabilities).toContainEqual({ code: "solana", label: "PAXG redeemable Solana tokens", amount: "2478" });
    expect(manifest.liabilities).toContainEqual({ code: "robinhood", label: "PAXG redeemable Robinhood tokens", amount: "5" });
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest, liabilities: manifest.liabilities.filter((row) => row.code !== "solana"),
    })).toThrow("liability total 428835 does not match manifest 431313");
  });
});
