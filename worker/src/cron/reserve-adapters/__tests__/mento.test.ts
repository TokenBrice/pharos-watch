import { describe, expect, it } from "vitest";
import { adaptMentoReserveComposition, parseMentoReserveComposition } from "../mento";

const SAMPLE_HTML = `
<html><body>
<script>
self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"sUSDS\\",\\"percent\\":54.8},{\\"symbol\\":\\"EURC\\",\\"percent\\":19.9},{\\"symbol\\":\\"CELO\\",\\"percent\\":13.5},{\\"symbol\\":\\"USDGLO\\",\\"percent\\":5.0},{\\"symbol\\":\\"stETH\\",\\"percent\\":2.6},{\\"symbol\\":\\"USDT\\",\\"percent\\":2.1},{\\"symbol\\":\\"USDC\\",\\"percent\\":1.2},{\\"symbol\\":\\"ETH\\",\\"percent\\":0.9}],\\"reserveHoldings\\":{}..."]);
</script>
</body></html>
`;

describe("mento adapter", () => {
  it("parses reserveComposition from the server-rendered payload", () => {
    const entries = parseMentoReserveComposition(SAMPLE_HTML);
    expect(entries).toEqual([
      { symbol: "sUSDS", percent: 54.8 },
      { symbol: "EURC", percent: 19.9 },
      { symbol: "CELO", percent: 13.5 },
      { symbol: "USDGLO", percent: 5.0 },
      { symbol: "stETH", percent: 2.6 },
      { symbol: "USDT", percent: 2.1 },
      { symbol: "USDC", percent: 1.2 },
      { symbol: "ETH", percent: 0.9 },
    ]);
  });

  it("maps parsed reserve composition into Pharos reserve slices", () => {
    const result = adaptMentoReserveComposition(SAMPLE_HTML);
    expect(result.slices).toEqual([
      { name: "sUSDS (Sky savings USDS)", pct: 54.8, risk: "low", coinId: "usds-sky" },
      { name: "EURC (Circle euro stablecoin)", pct: 19.9, risk: "low" },
      { name: "CELO", pct: 13.5, risk: "high" },
      { name: "USDGLO (Glo Dollar)", pct: 5, risk: "low" },
      { name: "stETH (Lido staked ETH)", pct: 2.6, risk: "low" },
      { name: "USDT", pct: 2.1, risk: "low", coinId: "usdt-tether" },
      { name: "USDC", pct: 1.2, risk: "low", coinId: "usdc-circle" },
      { name: "ETH", pct: 0.9, risk: "very-low" },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it("emits a structural integrity warning when fewer than 3 reserve entries are parsed", () => {
    const twoEntryHtml = `<html><body><script>self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":80},{\\"symbol\\":\\"ETH\\",\\"percent\\":20}],\\"reserveHoldings\\":{}..."]);
</script></body></html>`;
    const result = adaptMentoReserveComposition(twoEntryHtml);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.code === "mento-low-entry-count")).toBe(true);
  });

  it("rejects reserve payloads whose percentages do not cover the full reserve mix", () => {
    const lowPctHtml = `<html><body><script>self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":10},{\\"symbol\\":\\"ETH\\",\\"percent\\":5},{\\"symbol\\":\\"CELO\\",\\"percent\\":3}],\\"reserveHoldings\\":{}..."]);
</script></body></html>`;
    expect(() => adaptMentoReserveComposition(lowPctHtml)).toThrow("sum to 18.0%");
  });

  it("throws on missing reserveComposition marker", () => {
    expect(() => parseMentoReserveComposition("no data here")).toThrow("layout-changed");
  });

  it("throws on missing reserveHoldings delimiter", () => {
    const broken = `\\"reserveComposition\\":[{"symbol":"USDC","percent":40}]`;
    expect(() => parseMentoReserveComposition(broken)).toThrow("layout-changed");
  });

  it("throws parse-failed when the embedded reserve JSON is malformed", () => {
    const malformed = `<html><body><script>self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":40},bad-json],\\"reserveHoldings\\":{}..."]);
</script></body></html>`;
    expect(() => parseMentoReserveComposition(malformed)).toThrow("parse-failed");
  });

  it("annotates freshness as explicitly unverified with reason metadata", () => {
    const result = adaptMentoReserveComposition(SAMPLE_HTML);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "nextjs-embedded-payload",
      },
    });
  });

  it("emits an unknown-asset warning for symbols not in TOKEN_CONFIG", () => {
    const unknownTokenHtml = `<html><body><script>self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":50},{\\"symbol\\":\\"ETH\\",\\"percent\\":30},{\\"symbol\\":\\"NEW_TOKEN\\",\\"percent\\":10},{\\"symbol\\":\\"CELO\\",\\"percent\\":10}],\\"reserveHoldings\\":{}..."]);
</script></body></html>`;
    const result = adaptMentoReserveComposition(unknownTokenHtml);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.code === "unknown-asset" && w.message.includes("NEW_TOKEN"))).toBe(true);
  });
});
