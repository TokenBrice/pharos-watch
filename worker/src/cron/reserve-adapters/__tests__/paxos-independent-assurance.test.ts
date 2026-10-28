import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import {
  PaxosDiscoveryError,
  readPaxosReportSelection,
  verifyPaxosDiscovery,
} from "../paxos-independent-assurance";
import { PAXOS_REVIEWED_REPORT_ARCHIVE } from "../paxos-reviewed-report-archive";
import type { PaxosDiscoveryFailureCode, PaxosProductBinding } from "../paxos-independent-assurance";

const SITE = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl";
const MAIN_URL = `${SITE}/script_main.DWSgnPFN.mjs`;
const PAXG_ID = "9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU";
const PAXG_CHUNK = "Cm5Lb3KG";
const PAGE_URL = `${SITE}/${PAXG_ID}.${PAXG_CHUNK}.mjs`;
const REPORT_URL = getIndependentAssuranceManifest("PAXG").reportUrl;
const BINDING: PaxosProductBinding = {
  siteOrigin: SITE, routePath: "/paxg-transparency", pageModuleId: PAXG_ID,
  reviewedReportAssetIds: PAXOS_REVIEWED_REPORT_ARCHIVE.PAXG,
};
const fixture = (name: string) => readFileSync(new NodeURL(`./fixtures/paxos/${name}`, import.meta.url), "utf8")
  .replace(/^<!--[^]*?-->\s*/, "");
const INDEX = fixture("index-2026-10-14.html");
const MAIN = fixture("main-2026-10-14.mjs.txt");
// October 27 capture of the live product module listing the reviewed September 30 report.
const PAGE = fixture("paxg-2026-10-27.mjs.txt");
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

const admitted = (page: string, newerUrl?: string) => ({
  page, newerUnreviewedReport: newerUrl ? { reportUrl: newerUrl } : null,
});

async function expectFailure(promise: Promise<unknown>, code: PaxosDiscoveryFailureCode) {
  const error = await promise.then(
    () => { throw new Error(`expected discovery to reject with ${code}`); },
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(PaxosDiscoveryError);
  expect((error as PaxosDiscoveryError).code).toBe(code);
}

describe("Paxos discovered main module and report-selection list", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("accepts the current captured live index, main and reviewed product bytes", async () => {
    const installed = network();
    await expect(discover()).resolves.toEqual(admitted(PAGE));
    expect(installed.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("accepts a renamed main module with byte-identical product page", async () => {
    const renamed = `${SITE}/script_main.NewMainHash.mjs`;
    const html = INDEX.replace(MAIN_URL, renamed);
    installAdapterNetwork({ html: { [renamed]: MAIN, [PAGE_URL]: PAGE } });
    await expect(discover(html)).resolves.toEqual(admitted(PAGE));
  });

  it("reads the reviewed report selection from the real October 27 capture and the older September 30 capture", () => {
    expect(septemberBytes.byteLength).toBe(septemberCapture.rawByteLength);
    expect(hash(SEPTEMBER_PAGE)).toBe(septemberCapture.rawSha256);
    expect(hash(SEPTEMBER_PAGE)).toBe("3abe90e5439ad20619f0a1f799e4c4279f7ab5cc378177ba8efd97367c6f7048");
    expect(hash(PAGE)).toBe("790704ff5bcc995fc7b25b69e7f4887ec69348e1e18755744be0608518588375");
    const selection = readPaxosReportSelection(PAGE);
    // The September 30 capture predates only the September 30 report itself.
    expect(readPaxosReportSelection(SEPTEMBER_PAGE)).toEqual(selection.filter((url) => url !== REPORT_URL));
    expect(selection).toContain(REPORT_URL);
    expect(selection.map((url) => url.replace(/^.*\/(\w+)\.pdf$/, "$1")).sort()).toEqual([...BINDING.reviewedReportAssetIds].sort());
  });

  it("rejects a re-served historical capture that predates the reviewed report", async () => {
    const oldUrl = `${SITE}/${PAXG_ID}.-iP-KhFb.mjs`;
    const oldMain = MAIN.replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs`, `${PAXG_ID}.-iP-KhFb.mjs`);
    installAdapterNetwork({ html: { [MAIN_URL]: oldMain, [oldUrl]: SEPTEMBER_PAGE } });
    await expectFailure(discover(), "report-binding-missing");
  });

  // Import expressions below are unexecuted upstream-source attack fixtures,
  // not module loads in this test; static imports cannot represent that input.
  const republished = async (page: string) => {
    expect(page).not.toBe(PAGE);
    const nextUrl = `${SITE}/${PAXG_ID}.NextChunk.mjs`;
    const main = MAIN.replace(`${PAXG_ID}.${PAXG_CHUNK}.mjs`, `${PAXG_ID}.NextChunk.mjs`);
    installAdapterNetwork({ html: { [MAIN_URL]: main, [nextUrl]: page } });
    return discover();
  };
  const beforeSourceMap = (code: string) => PAGE.replace("\n//# sourceMappingURL=", `\n${code}\n//# sourceMappingURL=`);
  const NEWER = "https://framerusercontent.com/assets/SeptemberReport.pdf";

  it.each([
    ["same-length report label change", PAGE.replace("buttonText:`Aug`", "buttonText:`Sep`")],
    ["local binding rename", PAGE.replace("D as t", "D as renamedLocal")],
    ["module swap", PAGE.replace('from"./Pdfviewer.DCDdU355.mjs"', 'from"./PdfViewer.NewChunk.mjs"')],
    ["nonleading static imports", `const beforeImports=1;${PAGE}`],
    ["other byte change", beforeSourceMap("// non-source-map comment")],
  ])("admits cosmetic page churn while the reviewed selection is unchanged (%s)", async (_label, page) => {
    await expect(republished(page)).resolves.toEqual(admitted(page));
  });

  it.each([
    ["added literal entry", beforeSourceMap(`const september={file:\`${NEWER}\`};`)],
    ["added Framer variant override", beforeSourceMap(`const september={file:\`${REPORT_URL}\`,...q({Sep:{file:\`${NEWER}\`}},v,C)};`)],
  ])("reports a newer unreviewed report without failing (%s)", async (_label, page) => {
    await expect(republished(page)).resolves.toEqual(admitted(page, NEWER));
  });

  it.each([
    ["dynamic page import", beforeSourceMap("const report=await import('./SeptemberReport.mjs');")],
    ["dynamic import in template expression", beforeSourceMap("const report=`${await import('./SeptemberReport.mjs')}`;")],
    ["non-literal file entry", beforeSourceMap("const september={file:reportUrl};")],
    ["shorthand file entry", beforeSourceMap("const september={file};")],
    ["computed file entry", beforeSourceMap(`const september={["file"]:\`${NEWER}\`};`)],
    ["computed key overriding the reviewed entry", beforeSourceMap(
      `const september={file:\`${REPORT_URL}\`,["fi"+"le"]:"https://framerusercontent.com/assets/"+"Sept"+".pdf"};`,
    )],
    ["concatenated file value", beforeSourceMap('const september={file:"https://framerusercontent.com/assets/"+"Sept.pdf"};')],
    ["off-host file entry", beforeSourceMap("const september={file:`https://evil.example.com/report.pdf`};")],
    ["entry inside an opaque template", beforeSourceMap(`const september=\`\${x({file:\`${NEWER}\`})}\`;`)],
    ["asset URL inside a comment", beforeSourceMap(`// ${NEWER}`)],
    ["member assignment", beforeSourceMap('selection.file="https://framerusercontent.com/assets/"+"New.pdf";')],
    ["object spread after a reviewed file", beforeSourceMap(`const september={file:\`${REPORT_URL}\`,...reportOverride};`)],
    ["quoted key", beforeSourceMap(`const september={"file":\`${NEWER}\`};`)],
    ["escaped key", beforeSourceMap(`const september={"\\x66ile":\`${NEWER}\`};`)],
    ["getter", beforeSourceMap('const september={get file(){return "https://framerusercontent.com/assets/"+"New.pdf";}};')],
    ["computed accessor", beforeSourceMap('const september={get ["fi"+"le"](){return reportUrl;}};')],
    ["report-named computed member", beforeSourceMap('selection["file"]=reportUrl;')],
    ["concatenated computed member", beforeSourceMap('selection["fi"+"le"]=reportUrl;')],
  ])("rejects an unrecognized report selection (%s)", async (_label, page) => {
    await expectFailure(republished(page), "report-selection-unrecognized");
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
    await expect(discover()).resolves.toEqual(admitted(PAGE));
    network(`${main}const unrelated={};unrelated.page=()=>import('./OtherPage.Hash.mjs');`);
    await expect(discover()).resolves.toEqual(admitted(PAGE));
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

  it("fails closed when the reviewed report leaves the selection or the reviewed archive", async () => {
    const page = PAGE.replaceAll(`file:\`${REPORT_URL}\``, 'file:`https://framerusercontent.com/assets/OtherReport.pdf`');
    network(MAIN, page);
    await expectFailure(discover(), "report-binding-missing");
    network();
    const reviewedId = REPORT_URL.replace(/^.*\/(\w+)\.pdf$/, "$1");
    await expectFailure(discover(INDEX, {
      ...BINDING, reviewedReportAssetIds: BINDING.reviewedReportAssetIds.filter((id) => id !== reviewedId),
    }), "report-binding-missing");
  });

  it("reconciles every native gold liability and rejects an omitted Solana row", () => {
    const manifest = getIndependentAssuranceManifest("PAXG");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({ computedAssetTotal: "435306", liabilityTotal: "435306", collateralizationRatio: 1 });
    expect(manifest.liabilities).toContainEqual({ code: "solana", label: "PAXG redeemable Solana tokens", amount: "2560" });
    expect(manifest.liabilities).toContainEqual({ code: "robinhood", label: "PAXG redeemable Robinhood tokens", amount: "5" });
    expect(manifest.liabilities).toContainEqual({ code: "base", label: "PAXG redeemable Base tokens", amount: "235" });
    expect(() => reconcileIndependentAssuranceManifest({ ...manifest, liabilities: manifest.liabilities.filter((row) => row.code !== "solana") }))
      .toThrow("liability total 432746 does not match manifest 435306");
  });
});
