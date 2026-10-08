import octoberWire from "./leverup-oct7-2026.json";

// Six verbatim state responses at Monad 111423307, independently captured
// 2026-10-07T20:48:57.724Z. The market quote is historical production context:
// its quote timestamp/confidence were not retained and must stay unknown.
export const leverupOctoberObservation = {
  wire: octoberWire,
  block: {
    number: Number(octoberWire.block.number),
    timestamp: Date.parse(octoberWire.block.timestamp) / 1000,
    hash: octoberWire.block.hash,
  },
  marketPriceUsd: 0.9997246620495984,
} as const;

// captured-at: 2026-10-01
// rpc.monad.xyz, eth_call at 0x687ae37; DefiLlama USDC quote at 1790841690.
export const leverupObservation = {
  block: { number: 109555255, timestamp: 1790841761 },
  issuer: "0x135951057cfccca7e8ef87ee41318d670f723f68",
  transparency: "0x0ef8fd8f36cae470aff8b9d9bbd2e5f44fb23d51",
  vault: "0xc69d584b3118e94b3443cc6c67076281242fa704",
  reserveToken: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  lvusd: "0xfd44b35139ae53fff7d8f2a9869c503d987f00d1",
  vaultList: "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000c69d584b3118e94b3443cc6c67076281242fa704",
  reserveRaw: 905948910803n,
  supplyRaw: 1405949910803000000000000n,
  usdcPrice: 0.9998477374914292,
  quoteTimestamp: 1790841690,
} as const;
