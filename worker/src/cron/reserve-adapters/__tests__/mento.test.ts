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
    const slices = adaptMentoReserveComposition(SAMPLE_HTML);
    expect(slices).toEqual([
      { name: "sUSDS (Sky savings USDS)", pct: 54.8, risk: "low", coinId: "usds-sky" },
      { name: "EURC (Circle euro stablecoin)", pct: 19.9, risk: "low" },
      { name: "CELO", pct: 13.5, risk: "high" },
      { name: "USDGLO (Glo Dollar)", pct: 5, risk: "low" },
      { name: "stETH (Lido staked ETH)", pct: 2.6, risk: "low" },
      { name: "USDT", pct: 2.1, risk: "low", coinId: "usdt-tether" },
      { name: "USDC", pct: 1.2, risk: "low", coinId: "usdc-circle" },
      { name: "ETH", pct: 0.9, risk: "very-low" },
    ]);
  });
});
