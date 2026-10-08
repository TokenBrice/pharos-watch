import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, zeroAddress } from "viem";
import {
  requireScenarioChain,
  scenarioSourceAddress,
  scenarioDocumentWatch,
  type ScenarioCheck,
  type ScenarioCheckContext,
  type ScenarioCheckVerdict,
} from "./index";

const usdcAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function blacklister() view returns (address)",
  "function pauser() view returns (address)",
  "function paused() view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
]);
const psmAbi = parseAbi([
  "function pocket() view returns (address)",
  "function gem() view returns (address)",
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
]);
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi(["function fee() view returns (uint24)", "function token0() view returns (address)", "function token1() view returns (address)"]);
const curveAbi = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
]);
const quoteAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const dai = "0x6b175474e89094c44da98b954eedeac495271d0f";

function recordedFigure(context: ScenarioCheckContext, label: string): string {
  const figure = context.record.keyFigures.find((entry) => entry.label === label)?.value;
  if (!figure) throw new Error(`Missing recorded key figure: ${label}`);
  return figure;
}

function recordedExposure(context: ScenarioCheckContext, label: string, expression: RegExp): string {
  const detail = context.record.exposure.find((entry) => entry.label === label)?.detail;
  const figure = detail?.match(expression)?.[1];
  if (!figure) throw new Error(`Cannot parse recorded exposure: ${label}`);
  return figure;
}

// Compare at the precision actually published, not to a duplicated exact pin
// balance. Integer rounding avoids floating-point loss on token base units.
function comparePublished(amount: bigint, figure: string, decimals = 6): ScenarioCheckVerdict {
  const match = figure.match(/^(\d+)\.(\d+)([BM])?\b/);
  if (!match) throw new Error(`Cannot parse recorded numeric figure: ${figure}`);
  const exponent = decimals + (match[3] === "B" ? 9 : match[3] === "M" ? 6 : 0) - match[2].length;
  if (exponent < 0) throw new Error(`Recorded figure exceeds available token precision: ${figure}`);
  const unit = 10n ** BigInt(exponent);
  const expected = BigInt(match[1] + match[2]);
  const rounded = (amount + unit / 2n) / unit;
  return {
    verdict: rounded === expected ? "holds" : "changed",
    observed: formatUnits(amount, decimals),
    recorded: figure,
    reason: "Compared at the published rounding precision; this is token inventory/quote drift, not a reserve solvency or cash-access verdict.",
  };
}

function baselineBlock(context: ScenarioCheckContext): bigint {
  const block = context.record.sources.find((entry) => entry.id === "usdc-token")?.block;
  if (block === undefined) throw new Error("No recorded USDC role baseline block");
  return BigInt(block);
}

const checks: readonly ScenarioCheck[] = [
  scenarioDocumentWatch("bank-cash-exposure", "Reserve bank cash and settlement access",
    [{ sourceId: "reserves-august", publisher: "Deloitte / Circle" }],
    "The reserve attestation and continuity of bank/Treasury/repo settlement access cannot be verified from token chain state."),
  scenarioDocumentWatch("universal-redemption", "Non-EEA direct redemption eligibility",
    [{ sourceId: "usdc-terms", publisher: "Circle" }, { sourceId: "mint-terms", publisher: "Circle" }],
    "Circle Mint terms and enforceable non-EEA redemption eligibility are legal/account facts, not smart-contract state."),
  scenarioDocumentWatch("named-bank-exposure", "Named banks and replacement liquidity",
    [{ sourceId: "reserves-august", publisher: "Deloitte / Circle" }, { sourceId: "annual-filing", publisher: "Circle / SEC" }],
    "Named bank exposures and tested replacement liquidity require issuer disclosure; a reserve total or token balance cannot establish either."),
  scenarioDocumentWatch("standing-backstop", "Binding standing reserve-access backstop",
    [{ sourceId: "usdc-terms", publisher: "Circle" }, { sourceId: "mint-terms", publisher: "Circle" }, { sourceId: "federal-backstop", publisher: "Treasury / Federal Reserve / FDIC" }],
    "A discretionary historical rescue is not a binding standing guarantee. Legal terms and any newly issued backstop documents need human review."),
  ...(["blacklister", "pauser", "paused"] as const).map((functionName): ScenarioCheck => ({
    kind: "observation",
    id: `usdc-${functionName}`,
    label: `USDC ${functionName}`,
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "usdc-token");
      const recorded = await client.readContract({ address, abi: usdcAbi, functionName, blockNumber: baselineBlock(context) });
      const observed = await client.readContract({ address, abi: usdcAbi, functionName, blockNumber });
      const normalizedRecorded = typeof recorded === "string" ? recorded.toLowerCase() : recorded;
      const normalizedObserved = typeof observed === "string" ? observed.toLowerCase() : observed;
      return { verdict: normalizedRecorded === normalizedObserved ? "holds" : "changed", observed, recorded };
    },
  })),
  {
    kind: "figure",
    recordField: { collection: "keyFigures", label: "Ethereum token supply" },
    id: "usdc-ethereum-supply",
    label: "Ethereum USDC total supply",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const amount = await client.readContract({ address: scenarioSourceAddress(context.record, "usdc-token"), abi: usdcAbi, functionName: "totalSupply", blockNumber });
      return comparePublished(amount, recordedFigure(context, "Ethereum token supply"));
    },
  },
  {
    kind: "figure",
    recordField: { collection: "keyFigures", label: "Sky LitePSM pocket holding" },
    id: "usdc-litepsm-inventory",
    label: "Sky LitePSM USDC pocket inventory",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "litepsm");
      const token = scenarioSourceAddress(context.record, "usdc-token");
      const gem = await client.readContract({ address, abi: psmAbi, functionName: "gem", blockNumber });
      if (gem.toLowerCase() !== token.toLowerCase()) return { verdict: "changed", observed: gem, recorded: token, reason: "LitePSM gem is no longer the recorded Ethereum USDC token" };
      const pocket = await client.readContract({ address, abi: psmAbi, functionName: "pocket", blockNumber });
      const amount = await client.readContract({ address: token, abi: usdcAbi, functionName: "balanceOf", args: [pocket], blockNumber });
      const verdict = comparePublished(amount, recordedFigure(context, "Sky LitePSM pocket holding"));
      return { ...verdict, observed: { pocket, usdc: formatUnits(amount, 6) } };
    },
  },
  {
    kind: "observation",
    id: "usdc-litepsm-exit-controls",
    label: "Sky pocket blacklist state and LitePSM fees",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "litepsm");
      const pocket = await client.readContract({ address, abi: psmAbi, functionName: "pocket", blockNumber });
      const blacklisted = await client.readContract({ address: scenarioSourceAddress(context.record, "usdc-token"), abi: usdcAbi, functionName: "isBlacklisted", args: [pocket], blockNumber });
      const tin = await client.readContract({ address, abi: psmAbi, functionName: "tin", blockNumber });
      const tout = await client.readContract({ address, abi: psmAbi, functionName: "tout", blockNumber });
      return {
        verdict: !blacklisted && tin === 0n && tout === 0n ? "holds" : "changed",
        observed: { blacklisted, tin: tin.toString(), tout: tout.toString() },
        recorded: { blacklisted: false, tin: "0", tout: "0" },
        reason: context.record.exposure.find((entry) => entry.label === "Sky pocket holding")?.detail,
      };
    },
  },
  {
    kind: "figure",
    recordField: { collection: "exposure", label: "Sampled pool inventory" },
    id: "usdc-sampled-pool-inventory",
    label: "Seven sampled Curve/Uniswap pool USDC holdings",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const token = scenarioSourceAddress(context.record, "usdc-token");
      const addresses = ["curve-threepool", "curve-crvusd", "curve-ng"].map((id) => scenarioSourceAddress(context.record, id));
      for (const tokenOut of [usdt, dai] as const) {
        for (const fee of [100, 500]) {
          const address = await client.readContract({ address: scenarioSourceAddress(context.record, "uniswap-factory"), abi: factoryAbi, functionName: "getPool", args: [token, tokenOut, fee], blockNumber });
          if (address.toLowerCase() === zeroAddress) return { verdict: "unavailable", reason: `Recorded seven-pool sample cannot be reconstructed: missing ${tokenOut} fee ${fee} pool` };
          addresses.push(address);
        }
      }
      let amount = 0n;
      const holdings: Record<string, string> = {};
      for (const address of addresses) {
        const balance = await client.readContract({ address: token, abi: usdcAbi, functionName: "balanceOf", args: [address], blockNumber });
        amount += balance;
        holdings[address] = formatUnits(balance, 6);
      }
      const figure = recordedExposure(context, "Sampled pool inventory", /hold (\d+\.\d+M) USDC/);
      const verdict = comparePublished(amount, figure);
      return { ...verdict, observed: { totalUsdc: formatUnits(amount, 6), holdings } };
    },
  },
  {
    kind: "figure",
    recordField: { collection: "keyFigures", label: "USDT per USDC, 10M sale" },
    id: "usdc-uniswap-ten-million-quote",
    label: "Uniswap USDC/USDT static 10M sale quote",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const token = scenarioSourceAddress(context.record, "usdc-token");
      const pool = scenarioSourceAddress(context.record, "uniswap-usdt");
      const token0 = await client.readContract({ address: pool, abi: poolAbi, functionName: "token0", blockNumber });
      const token1 = await client.readContract({ address: pool, abi: poolAbi, functionName: "token1", blockNumber });
      if (![token0, token1].some((entry) => entry.toLowerCase() === token.toLowerCase()) || ![token0, token1].some((entry) => entry.toLowerCase() === usdt)) {
        return { verdict: "changed", observed: [token0, token1], recorded: [token, usdt], reason: "Recorded USDC/USDT pool token pair changed" };
      }
      const fee = await client.readContract({ address: pool, abi: poolAbi, functionName: "fee", blockNumber });
      const call = await client.call({
        to: scenarioSourceAddress(context.record, "uniswap-quoter"),
        data: encodeFunctionData({
          abi: quoteAbi, functionName: "quoteExactInputSingle",
          args: [{ tokenIn: token, tokenOut: usdt, amountIn: 10_000_000n * 10n ** 6n, fee, sqrtPriceLimitX96: 0n }],
        }),
        blockNumber,
      });
      if (!call.data) return { verdict: "unavailable", reason: "Uniswap QuoterV2 returned no quote data" };
      const data = decodeFunctionResult({ abi: quoteAbi, functionName: "quoteExactInputSingle", data: call.data });
      // QuoterV2's non-view quote runs exclusively via eth_call, never a transaction.
      return comparePublished(data[0], recordedFigure(context, "USDT per USDC, 10M sale"), 13);
    },
  },
  {
    kind: "figure",
    recordField: { collection: "exposure", label: "Static exit quotes" },
    id: "usdc-curve-hundred-million-quote",
    label: "Curve 3pool static 100M USDC sale quote",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "curve-threepool");
      const token = await client.readContract({ address, abi: curveAbi, functionName: "coins", args: [1n], blockNumber });
      const output = await client.readContract({ address, abi: curveAbi, functionName: "coins", args: [2n], blockNumber });
      if (token.toLowerCase() !== scenarioSourceAddress(context.record, "usdc-token").toLowerCase() || output.toLowerCase() !== usdt) {
        return { verdict: "changed", observed: [token, output], recorded: [scenarioSourceAddress(context.record, "usdc-token"), usdt], reason: "Curve 3pool token indices changed" };
      }
      const amount = await client.readContract({ address, abi: curveAbi, functionName: "get_dy", args: [1n, 2n, 100_000_000n * 10n ** 6n], blockNumber });
      return comparePublished(amount, recordedExposure(context, "Static exit quotes", /quotes (\d+\.\d+M) USDT/));
    },
  },
];

export default checks;
