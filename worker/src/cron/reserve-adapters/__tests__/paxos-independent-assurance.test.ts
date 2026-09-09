import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import type { AdapterHttpResponse } from "./reserve-adapter.test-support";
import { verifyPaxosDiscovery, type PaxosDiscoveryPin } from "../paxos-independent-assurance";

const MAIN = "reviewed product route";
const PAGE = "reviewed PAXG July 2026 PDF selection";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const PIN: PaxosDiscoveryPin = {
  mainUrl: "https://framerusercontent.com/sites/reviewed/script_main.mjs",
  mainSha256: hash(MAIN),
  pageUrl: "https://framerusercontent.com/sites/reviewed/paxg.mjs",
  pageSha256: hash(PAGE),
};
const HTML = `<script src="${PIN.mainUrl}"></script>`;

function installFetch(changedUrl?: string, redirect = false) {
  const network = installAdapterNetwork({
    html: {
      [PIN.mainUrl]: (): string | AdapterHttpResponse => redirect
        ? { body: MAIN, url: "https://example.com/changed" }
        : (PIN.mainUrl === changedUrl ? `${MAIN} changed` : MAIN),
      [PIN.pageUrl]: (): string | AdapterHttpResponse => redirect
        ? { body: PAGE, url: "https://example.com/changed" }
        : (PIN.pageUrl === changedUrl ? `${PAGE} changed` : PAGE),
    },
  });
  return network.fetchSpy;
}

describe("Paxos reviewed Framer discovery", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("checks both module hashes before accepting the reviewed product selection", async () => {
    const fetchMock = installFetch();
    await expect(verifyPaxosDiscovery(HTML, PIN, AbortSignal.timeout(1000))).resolves.toBe(PAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([PIN.mainUrl, PIN.pageUrl])("rejects a changed module at %s, including newer report selection", async (url) => {
    const fetchMock = installFetch(url);
    await expect(verifyPaxosDiscovery(HTML, PIN, AbortSignal.timeout(1000))).rejects.toThrow("website module changed");
    // The hash loop short-circuits on the first mismatch: a changed main module throws before the page is fetched.
    expect(fetchMock).toHaveBeenCalledTimes(url === PIN.mainUrl ? 1 : 2);
  });

  it.each(["", HTML + HTML, HTML.replace("script_main.mjs", "script_main.new.mjs")])("rejects missing, ambiguous or changed official routing", async (html) => {
    const fetchMock = installFetch();
    await expect(verifyPaxosDiscovery(html, PIN, AbortSignal.timeout(1000))).rejects.toThrow("changed or ambiguous main module");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects module redirects", async () => {
    installFetch(undefined, true);
    await expect(verifyPaxosDiscovery(HTML, PIN, AbortSignal.timeout(1000))).rejects.toThrow("response URL drifted");
  });

  it("reconciles both native chains to gold ounces and rejects an omitted Solana liability", () => {
    const manifest = getIndependentAssuranceManifest("PAXG");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "442217", liabilityTotal: "442217", collateralizationRatio: 1,
    });
    expect(manifest.liabilities).toContainEqual({ code: "solana", label: "PAXG redeemable Solana tokens", amount: "278" });
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest, liabilities: manifest.liabilities.filter((row) => row.code !== "solana"),
    })).toThrow("liability total 441939 does not match manifest 442217");
  });
});
