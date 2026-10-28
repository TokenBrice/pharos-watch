import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import type { ChainTrackedDeployment } from "../static-chain-content";
import { ChainContractTable } from "./chain-contract-table";

type ContractDeployment = NonNullable<StablecoinMeta["contracts"]>[number];

function deployment({
  id = "fixture-usd",
  symbol = "FIX",
  name = "Fixture USD",
  isNavOrVariant = false,
  contracts,
}: {
  id?: string;
  symbol?: string;
  name?: string;
  isNavOrVariant?: boolean;
  contracts: ContractDeployment[];
}): ChainTrackedDeployment {
  return {
    id,
    name,
    symbol,
    href: `/stablecoin/${id}/`,
    pegLabel: "US Dollar",
    backingLabel: "RWA",
    governanceLabel: "CeFi",
    contractCount: contracts.length,
    contracts,
    isNavOrVariant,
  };
}

function render(deployments: ChainTrackedDeployment[], chainName = "Base") {
  return renderToStaticMarkup(<ChainContractTable chainName={chainName} deployments={deployments} />);
}

function rowCount(html: string) {
  return html.match(/scope="row"/g)?.length ?? 0;
}

describe("ChainContractTable", () => {
  it("renders null decimals as a dash and explicit zero as a measured zero", () => {
    const html = render([
      deployment({
        contracts: [
          { chain: "base", address: "0x1111111111111111111111111111111111111111", decimals: 0 },
          { chain: "kava", address: "usdx", decimals: null, kind: "native-denom" },
        ],
      }),
    ]);

    expect(html).toContain("0x1111111111111111111111111111111111111111");
    const zeroRow = html.slice(html.indexOf("0x1111111111111111111111111111111111111111"));
    expect(zeroRow.slice(0, zeroRow.indexOf("</tr>"))).toContain(">0<");
    const nullRow = html.slice(html.indexOf(">usdx</td>"));
    expect(nullRow.slice(0, nullRow.indexOf("</tr>"))).toContain(">—<");
  });

  it("renders an unavailable explorer as a dash and never fabricates a link", () => {
    const html = render([
      deployment({ contracts: [{ chain: "kava", address: "usdx", decimals: 6, kind: "native-denom" }] }),
    ]);

    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("Explorer</a>");
    expect(html).toContain("—");
  });

  it("keeps two addresses on one chain as two distinct rows pointing at the profile fold", () => {
    const contracts: ContractDeployment[] = [
      { chain: "base", address: "0x1111111111111111111111111111111111111111", decimals: 18 },
      { chain: "base", address: "0x2222222222222222222222222222222222222222", decimals: 18 },
    ];
    const html = render([deployment({ contracts })]);

    expect(rowCount(html)).toBe(2);
    for (const contract of contracts) {
      expect(html).toContain(contract.address);
    }
    // One shared module target: the profile's `#contracts` fold lists both
    // addresses, so rows need no per-deployment fragment.
    expect(html.match(/href="\/stablecoin\/fixture-usd#contracts"/g)).toHaveLength(2);
    expect(html).not.toContain("contract-base");
  });

  it("caps rows at 20 while the caption reports the complete candidate total", () => {
    const deployments = [
      deployment({
        contracts: Array.from({ length: 23 }, (_, index) => ({
          chain: "base",
          address: `0x${index.toString().padStart(40, "0")}`,
          decimals: 18,
        })),
      }),
      deployment({
        id: "variant-fixture",
        contracts: [{ chain: "base", address: "0x9999999999999999999999999999999999999999", decimals: 18 }],
      }),
    ];
    const html = render(deployments);

    expect(rowCount(html)).toBe(20);
    expect(html).toContain("Showing 20 of 24 recorded deployments");
    // The overflow coin is still reachable through the complete directory on
    // the page; the table's own bound is presentational only.
    expect(html).not.toContain("0x9999999999999999999999999999999999999999");
  });

  it("orders base coins before NAV tokens and variants", () => {
    const html = render([
      deployment({
        id: "variant-first",
        isNavOrVariant: true,
        contracts: [{ chain: "base", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decimals: 18 }],
      }),
      deployment({
        id: "base-second",
        contracts: [{ chain: "base", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 18 }],
      }),
    ]);

    expect(html.indexOf("/stablecoin/base-second#")).toBeGreaterThan(-1);
    expect(html.indexOf("/stablecoin/base-second#")).toBeLessThan(html.indexOf("/stablecoin/variant-first#"));
  });

  it("omits the section when the chain has no candidate rows", () => {
    expect(render([])).toBe("");
    expect(render([deployment({ contracts: [] })])).toBe("");
  });
});
