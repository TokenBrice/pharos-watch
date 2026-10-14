import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import {
  normalizePaxosPageModule,
  PaxosDiscoveryError,
  verifyPaxosDiscovery,
} from "../paxos-independent-assurance";
import type { PaxosDiscoveryFailureCode, PaxosProductBinding } from "../paxos-independent-assurance";

const SITE = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl";
const MAIN_URL = `${SITE}/script_main.DWSgnPFN.mjs`;
const PAXG_ID = "9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU";
const PAXG_CHUNK = "Cm5Lb3KG";
const PAGE_URL = `${SITE}/${PAXG_ID}.${PAXG_CHUNK}.mjs`;
const REPORT_URL = getIndependentAssuranceManifest("PAXG").reportUrl;
const BINDING: PaxosProductBinding = {
  siteOrigin: SITE, routePath: "/paxg-transparency", pageModuleId: PAXG_ID,
  pageNormalizedSha256: "7fb418d7c26b71b29131c8b0b2a876103900a2da7ecd8bd2d01a7b6d9e3e1deb",
  pageNormalizedByteLength: 444412,
};
const fixture = (name: string) => readFileSync(new NodeURL(`./fixtures/paxos/${name}`, import.meta.url), "utf8")
  .replace(/^<!--[^]*?-->\s*/, "");
const INDEX = fixture("index-2026-10-14.html");
const MAIN = fixture("main-2026-10-14.mjs.txt");
// The October 13 capture is byte-identical to the verified October 14 product.
const PAGE = fixture("paxg-2026-10-13.mjs.txt");
const septemberCapture: { gzipBase64: string; rawSha256: string; rawByteLength: number } = JSON.parse(fixture("paxg-2026-09-30.module.json"));
const septemberBytes = gunzipSync(Buffer.from(septemberCapture.gzipBase64, "base64"));
const SEPTEMBER_PAGE = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(septemberBytes);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const route = (path: string, module = `${PAXG_ID}.${PAXG_CHUNK}.mjs`) =>
  `{page:L(()=>import(\`./${module}\`)),path:${path}}`;
const discover = (html = INDEX, binding = BINDING) =>
  verifyPaxosDiscovery(html, binding, REPORT_URL, AbortSignal.timeout(5000));

function network(main = MAIN, page = PAGE) {
  return installAdapterNetwork({ html: { [MAIN_URL]: main, [PAGE_URL]: page } });
}

async function expectFailure(promise: Promise<string>, code: PaxosDiscoveryFailureCode) {
  const error = await promise.then(
    () => { throw new Error(`expected discovery to reject with ${code}`); },
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(PaxosDiscoveryError);
  expect((error as PaxosDiscoveryError).code).toBe(code);
}

describe("Paxos discovered main module and pinned normalized page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("accepts the current captured live index, main and reviewed product bytes", async () => {
    const installed = network();
    await expect(discover()).resolves.toBe(PAGE);
    expect(installed.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("accepts a renamed main module with byte-identical product page", async () => {
    const renamed = `${SITE}/script_main.NewMainHash.mjs`;
    const html = INDEX.replace(MAIN_URL, renamed);
    installAdapterNetwork({ html: { [renamed]: MAIN, [PAGE_URL]: PAGE } });
    await expect(discover(html)).resolves.toBe(PAGE);
  });

  it("normalizes the two real September 30 and October 13 captures to the same pinned bytes", () => {
    expect(septemberBytes.byteLength).toBe(septemberCapture.rawByteLength);
    expect(hash(SEPTEMBER_PAGE)).toBe(septemberCapture.rawSha256);
    expect(hash(SEPTEMBER_PAGE)).toBe("3abe90e5439ad20619f0a1f799e4c4279f7ab5cc378177ba8efd97367c6f7048");
    expect(hash(PAGE)).toBe("cc505dc4eafcf862c1a9adda08da12c9864cda8ba52ffb4b22a4f9468d37e53a");
    const oldNormalized = normalizePaxosPageModule(SEPTEMBER_PAGE);
    const newNormalized = normalizePaxosPageModule(PAGE);
    expect(oldNormalized).toBe(newNormalized);
    expect(hash(newNormalized)).toBe(BINDING.pageNormalizedSha256);
    expect(Buffer.byteLength(newNormalized)).toBe(BINDING.pageNormalizedByteLength);
  });

  it("accepts historical import/export-name churn with identical locals and body", async () => {
    const oldUrl = `${SITE}/${PAXG_ID}.-iP-KhFb.mjs`;
    const oldMain = MAIN.replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs`, `${PAXG_ID}.-iP-KhFb.mjs`);
    installAdapterNetwork({ html: { [MAIN_URL]: oldMain, [oldUrl]: SEPTEMBER_PAGE } });
    await expect(discover()).resolves.toBe(SEPTEMBER_PAGE);
  });

  it("normalizes leading import hash/export churn while preserving module basenames and locals", () => {
    const first = 'import Foo,{C as local,a as other}from"./chunk.OldHash.mjs";const page=local;\n//# sourceMappingURL=page.OldHash.mjs.map';
    const second = 'import Foo,{M as local,b as other}from"./chunk.NewHash.mjs";const page=local;\n//# sourceMappingURL=page.NewHash.mjs.map';
    expect(normalizePaxosPageModule(first)).toBe(normalizePaxosPageModule(second));
    const inert = 'const text=\'import("./old.Hash.mjs")\';';
    expect(normalizePaxosPageModule(inert)).toBe(inert);
  });

  // Import expressions below are unexecuted upstream-source attack fixtures,
  // not module loads in this test; static imports cannot represent that input.
  it.each(["AugustReport", "SeptemberReport"])("rejects the reviewer's dynamic import collision (%s)", (module) => {
    expect(() => normalizePaxosPageModule(`const report=await import("./${module}.mjs");`))
      .toThrow("dynamic import in product page module");
  });

  it.each([
    ["added September report", PAGE.replace("\n//# sourceMappingURL=", "\nconst september={file:`https://framerusercontent.com/assets/SeptemberReport.pdf`};\n//# sourceMappingURL=")],
    ["same-length report label change", PAGE.replace("buttonText:`Aug`", "buttonText:`Sep`")],
    ["local binding rename", PAGE.replace("D as t", "D as renamedLocal")],
    ["module swap from reviewer", PAGE.replace('from"./Pdfviewer.B-RMKdz-.mjs"', 'from"./SeptemberReportViewer.NewChunk.mjs"')],
    ["dynamic page import", PAGE.replace("\n//# sourceMappingURL=", "\nconst report=await import('./SeptemberReport.mjs');\n//# sourceMappingURL=")],
    ["dynamic import in template expression", PAGE.replace("\n//# sourceMappingURL=", "\nconst report=`${await import('./SeptemberReport.mjs')}`;\n//# sourceMappingURL=")],
    ["nonleading static imports", `const beforeImports=1;${PAGE}`],
    ["second source-map comment", `//# sourceMappingURL=other.Hash.mjs.map\n${PAGE}`],
    ["nonfinal source-map comment", `${PAGE}\nconst afterMap=1;`],
    ["other byte change", PAGE.replace("\n//# sourceMappingURL=", "\n// non-source-map comment\n//# sourceMappingURL=")],
  ])("rejects changed product bytes despite the same module identity (%s)", async (_label, page) => {
    expect(page).not.toBe(PAGE);
    const nextUrl = `${SITE}/${PAXG_ID}.NextChunk.mjs`;
    const main = MAIN.replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs`, `${PAXG_ID}.NextChunk.mjs`);
    installAdapterNetwork({ html: { [MAIN_URL]: main, [nextUrl]: page } });
    await expectFailure(discover(), "page-module-bytes-drifted");
  });

  it.each(["\n", "\r", "\u2028", "\u2029"])("ignores comment decoys and recognizes executable computed paths after %j", async (terminator) => {
    const commented = route("`/paxg-transparency`");
    const active = route('`/paxg-${"transparency"}`', "UnreviewedPage.NewHash.mjs");
    const installed = network(`//${commented}${terminator}const active=${active};`);
    await expectFailure(discover(), "route-table-unrecognized");
    expect(installed.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    `/*${route("`/paxg-transparency`")}*/`,
    `const inert=${JSON.stringify(route("`/paxg-transparency`"))};`,
    `const inert=\`import("./${PAXG_ID}.${PAXG_CHUNK}.mjs"),path:"/paxg-transparency"\`;`,
    'const inert=`before ${"nested ` template text"} after`;',
    `const inert=/import\\(.*\\)path:\\x60\\/paxg-transparency\\x60/;`,
    `if(ready)/import\\(.*\\)path:\\x60\\/paxg-transparency\\x60/.test("text");`,
  ])("ignores routes inside comments, strings, templates and regular expressions", async (decoy) => {
    network(`${decoy}const active=${route("`/other-route`")};`);
    await expectFailure(discover(), "route-binding-missing");
  });

  it.each([
    '`/paxg-${"transparency"}`',
    '`/paxg-` + "transparency"',
    '`/other-route`.replace("other-route","paxg-transparency")',
    'computedPath',
  ])("rejects a nonliteral/partial route path (%s)", async (path) => {
    network(`const routes=${route(path)};`);
    await expectFailure(discover(), "route-table-unrecognized");
  });

  it("rejects computed property and shorthand route paths", async () => {
    network(`const routes={page:L(()=>import(\`./${PAXG_ID}.${PAXG_CHUNK}.mjs\`)),["path"]:\`/paxg-transparency\`};`);
    await expectFailure(discover(), "route-table-unrecognized");
    network(`const routes={page:L(()=>import(\`./${PAXG_ID}.${PAXG_CHUNK}.mjs\`)),path};`);
    await expectFailure(discover(), "route-table-unrecognized");
  });

  it("rejects duplicate active bindings", async () => {
    network(`const routes=[${route("`/paxg-transparency`")},${route("`/paxg-transparency`")}];`);
    await expectFailure(discover(), "route-binding-ambiguous");
  });

  it.each([
    `const L=()=>()=>import('./NewPage.Hash.mjs');const routes=${route("'/paxg-transparency'")};`,
    `const newer={page:()=>import('./NewPage.Hash.mjs')};const routes={page:L(()=>import('./${PAXG_ID}.${PAXG_CHUNK}.mjs')),path:'/paxg-transparency',...newer};`,
    `const routes=${route("'/paxg-transparency'")};routes.page=()=>import('./NewPage.Hash.mjs');`,
  ])("rejects the reviewer's helper, spread and later-assignment repros", async (main) => {
    network(main);
    await expectFailure(discover(), "route-table-unrecognized");
  });

  it("corroborates the product wrapper against the other route entries", async () => {
    const main = `const routes={product:${route("'/paxg-transparency'")},other:${route("'/other-route'")}};`;
    network(main);
    await expect(discover()).resolves.toBe(PAGE);
    network(`${main}const unrelated={};unrelated.page=()=>import('./OtherPage.Hash.mjs');`);
    await expect(discover()).resolves.toBe(PAGE);
    network(main.replace("product:{page:L(", "product:{page:UnreviewedHelper("));
    await expectFailure(discover(), "route-table-unrecognized");
  });

  it.each(["routes.product.page", 'routes["product"]["page"]'])("rejects later page writes in a corroborated table (%s)", async (member) => {
    const main = `const routes={product:${route("'/paxg-transparency'")},other:${route("'/other-route'")}};${member}=()=>import('./NewPage.Hash.mjs');`;
    network(main);
    await expectFailure(discover(), "route-table-unrecognized");
  });

  it("rejects spreads in a corroborated product route table", async () => {
    network(`const newer={page:()=>import('./NewPage.Hash.mjs')};const routes={product:${route("'/paxg-transparency'").slice(0, -1)},...newer},other:${route("'/other-route'")}};`);
    await expectFailure(discover(), "route-table-unrecognized");
  });

  it("rejects unrecognized page imports and unterminated comments", async () => {
    network('const routes={page:L(()=>import(moduleName)),path:`/paxg-transparency`};');
    await expectFailure(discover(), "route-table-unrecognized");
    network(`${MAIN}\n/* unterminated`);
    await expectFailure(discover(), "route-table-unrecognized");
  });

  it("rejects missing and ambiguous main scripts without fetching", async () => {
    const installed = network();
    await expectFailure(discover("<html></html>"), "main-module-missing");
    await expectFailure(discover(INDEX + INDEX), "main-module-ambiguous");
    expect(installed.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unreviewed main origin and page identity", async () => {
    const installed = network();
    await expectFailure(discover(INDEX.replace(SITE, "https://evil.example.com")), "main-module-origin-drifted");
    expect(installed.fetchSpy).not.toHaveBeenCalled();
    network(MAIN.replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs`, "UnreviewedPage.NewHash.mjs"));
    await expectFailure(discover(), "page-module-identity-drifted");
  });

  it("rejects main and page redirects", async () => {
    installAdapterNetwork({ html: { [MAIN_URL]: { body: MAIN, url: `${MAIN_URL}.redirect` } } });
    await expectFailure(discover(), "main-module-response-drifted");
    installAdapterNetwork({ html: { [MAIN_URL]: MAIN, [PAGE_URL]: { body: PAGE, url: `${PAGE_URL}.redirect` } } });
    await expectFailure(discover(), "page-module-response-drifted");
  });

  it("retains the redundant reviewed-report binding guard after byte admission", async () => {
    const page = PAGE.replaceAll(`file:\`${REPORT_URL}\``, 'file:`https://framerusercontent.com/assets/OtherReport.pdf`');
    const normalized = normalizePaxosPageModule(page);
    network(MAIN, page);
    await expectFailure(discover(INDEX, {
      ...BINDING, pageNormalizedSha256: hash(normalized), pageNormalizedByteLength: Buffer.byteLength(normalized),
    }), "report-binding-missing");
  });

  it("reconciles every native gold liability and rejects an omitted Solana row", () => {
    const manifest = getIndependentAssuranceManifest("PAXG");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({ computedAssetTotal: "431313", liabilityTotal: "431313", collateralizationRatio: 1 });
    expect(manifest.liabilities).toContainEqual({ code: "solana", label: "PAXG redeemable Solana tokens", amount: "2478" });
    expect(manifest.liabilities).toContainEqual({ code: "robinhood", label: "PAXG redeemable Robinhood tokens", amount: "5" });
    expect(() => reconcileIndependentAssuranceManifest({ ...manifest, liabilities: manifest.liabilities.filter((row) => row.code !== "solana") }))
      .toThrow("liability total 428835 does not match manifest 431313");
  });
});
