// Dependency-free so memory-constrained cron lanes (stale-pool refresh) can
// import the chain list without the fetcher's runtime graph.
/**
 * Aero (aero.xyz) — the 2026-10-22 merger of Aerodrome and Velodrome — on its
 * seven launch chains. Aero publishes no Sugar or HTTP pool API, so pools are
 * enumerated straight from the factories. Reviewed against Dromos Labs'
 * deployment registries (`dromos-labs/metadex-public` and
 * `metadex-slipstream-public`, `deployment-addresses/`) and live
 * `allPoolsLength()` reads on 2026-10-23. Arc also carries the pre-merger
 * "Aero Lite" factories, which the DefiLlama Aero listing includes. Ink is
 * omitted: the reviewed Worker RPC profile has no Ink endpoint (and Aero held
 * ~$0 there at launch); GeckoTerminal `aero-slipstream-ink` rows still stage.
 */
export const AERO_DEPLOYMENTS: readonly {
  chain: string;
  clFactories: readonly `0x${string}`[];
  stableFactories: readonly `0x${string}`[];
  volatileFactories: readonly `0x${string}`[];
}[] = [
  ...([
    ["base", "0x9cb220581b91b0c83223012fe69688b92ad07a76"],
    ["ethereum", "0xf4fd2e6c5b60c5b365cd1b96dd6245e6d60414c2"],
    ["optimism", "0xfeab42d90055db3a0616249f76b6002d72266778"],
    ["arbitrum", "0x88a60ee77392577c355c0acb2a8d476d5a4ec03a"],
    ["robinhood", "0xc63d7338c178e805c544b8f897066bd3bbcbe136"],
  ] as const).map(([chain, clFactory]) => ({
    chain,
    clFactories: [clFactory],
    stableFactories: ["0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d" as const],
    volatileFactories: ["0x8e6a9fcd1d638cc760ffba397605fe3355de76d2" as const],
  })),
  {
    chain: "arc",
    clFactories: ["0x7f83235643181e440433400a027618cd50879751", "0xb89df768af2cfe637ceb352c587fe8edaf491d03"],
    stableFactories: ["0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d", "0xaed253f1ad84d99f2165256d701b2b481dd4cc16"],
    volatileFactories: ["0x8e6a9fcd1d638cc760ffba397605fe3355de76d2", "0x9bc8b3f60d349d687fb44a018967025e3741f9a5"],
  },
];

export const AERO_CHAINS: readonly string[] = AERO_DEPLOYMENTS.map((deployment) => deployment.chain);
