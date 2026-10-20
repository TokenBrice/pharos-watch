import type { AlchemyLogEntry, AlchemyTransactionContextBatch } from "../alchemy-logs";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import type { MintBurnContractConfig, MintBurnEventDef } from "../mint-burn-contracts";
import type { MintBurnPriceContext } from "../mint-burn-pipeline/types";
import reviewed from "../mint-burn-conservation-reviewed.json";

export const reviewedFalseBurnEntries = reviewed.entries.filter((entry) =>
  entry.unsupportedReason?.startsWith("zero-address-transfer-without-supply-change:"));
export const abiWord = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const USER = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const USER_WORD = `0x${"0".repeat(24)}${USER.slice(2)}`;
const ZERO = abiWord(0n);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
interface SourcePathFixture {
  source: string;
  selector?: string;
  accountArgument?: boolean;
  eventTopic?: string;
  accountTopic?: number;
}
export interface ReviewedBurnFixture {
  config: MintBurnContractConfig;
  eventDef: MintBurnEventDef;
  log: AlchemyLogEntry;
  proofLog: AlchemyLogEntry | null;
  source: SourcePathFixture;
  context: (actualBurn: boolean) => AlchemyTransactionContextBatch;
  amount: number;
  timestamps: Map<number, number>;
  priceContext: MintBurnPriceContext;
}
// Independent source-path expectations, not a production admission registry.
// Missing fixtures fail the sidecar-iterating tests when reviewed identities grow.
const SOURCE_PATHS: Record<string, SourcePathFixture> = {
  "ausd-agora": { source: "Erc20Privileged.sol:164-185/254 _burn/Burned", eventTopic: "0x6ab368f832c266c8eb942b84fbcaa20aedc24a699d2a05fae2568028733b1d09", accountTopic: 2 },
  "dai-makerdao": { source: "Dai.sol:139-148 burn(address,uint256)", selector: "0x9dc29fac", accountArgument: true },
  "dola-inverse-finance": { source: "contracts/ERC20.sol:80-94 burn(uint256)", selector: "0x42966c68" },
  "eurs-stasis": { source: "EURSToken.sol:247-261 burnTokens(uint256)", selector: "0x6d1b229d" },
  "gho-aave": { source: "GhoToken.sol:49-60 / ERC20.sol:174-184 burn(uint256)", selector: "0x42966c68" },
  "pht-pht": { source: "Dai.sol:100-109 burn(address,uint256)", selector: "0x9dc29fac", accountArgument: true },
  "pusd-plume": { source: "BoringVault.sol:117-134 exit / Exit shares (not assets)", eventTopic: "0xe0c82280a1164680e0cf43be7db4c4c9f985423623ad7a544fb76c772bdc6043", accountTopic: 3 },
  "syrupusdc-maple": { source: "MaplePool.sol:1118-1132 _burn / Withdraw shares", eventTopic: "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db", accountTopic: 3 },
  "syrupusdt-maple": { source: "MaplePool.sol:1118-1132 _burn / Withdraw shares", eventTopic: "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db", accountTopic: 3 },
  "usdd-tron-dao-reserve": { source: "src/dss/usdd.sol:92-101 burn(address,uint256)", selector: "0x9dc29fac", accountArgument: true },
  "usyc-hashnote": { source: "YieldCoin.sol:192-194 burnFor / ERC20.sol:108-117 _burn", selector: "0x1dd319cb", accountArgument: true },
};

export function reviewedBurnFixture(stablecoinId: string): ReviewedBurnFixture {
  const entry = reviewedFalseBurnEntries.find((item) => item.stablecoinId === stablecoinId);
  const source = SOURCE_PATHS[stablecoinId];
  if (!entry || !source) throw new Error(`Missing paired burn/source-path fixture: ${stablecoinId}`);
  const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === entry.stablecoinId
    && item.chain.chainId === entry.chainId && item.contractAddress.toLowerCase() === entry.address
    && item.decimals === entry.decimals);
  if (!config) throw new Error(`Missing exact reviewed config: ${stablecoinId}`);
  const eventDef = config.events.find((event) => event.direction === "burn")!;
  const amount = 20_000;
  const raw = abiWord(BigInt(amount) * 10n ** BigInt(config.decimals));
  const log: AlchemyLogEntry = {
    address: config.contractAddress, topics: [TRANSFER, USER_WORD, ZERO], data: raw,
    blockNumber: "0x18e41a0", blockHash: abiWord(12n), logIndex: "0x0", transactionIndex: "0x0",
    transactionHash: abiWord(20n), removed: false,
  };
  const proofLog: AlchemyLogEntry | null = source.eventTopic ? {
    ...log, logIndex: "0x1", topics: source.accountTopic === 2
      ? [source.eventTopic, USER_WORD, USER_WORD] : [source.eventTopic, USER_WORD, USER_WORD, USER_WORD],
    data: source.accountTopic === 2 ? raw : `0x${abiWord(999n).slice(2)}${raw.slice(2)}`,
  } : null;
  const ordinaryInput = `0xa9059cbb${ZERO.slice(2)}${raw.slice(2)}`;
  const burnInput = source.selector
    ? `${source.selector}${source.accountArgument ? USER_WORD.slice(2) : ""}${raw.slice(2)}` : ordinaryInput;
  const context = (actualBurn: boolean): AlchemyTransactionContextBatch => {
    const to = actualBurn && proofLog ? ROUTER : config.contractAddress;
    return {
      tx: { hash: log.transactionHash, from: USER, to, input: actualBurn ? burnInput : ordinaryInput,
        blockHash: log.blockHash, blockNumber: log.blockNumber },
      receipt: { transactionHash: log.transactionHash, to, blockHash: log.blockHash,
        blockNumber: log.blockNumber, status: "0x1", logs: actualBurn && proofLog ? [log, proofLog] : [log] },
    };
  };
  return { config, eventDef, log, proofLog, source, context, amount,
    timestamps: new Map([[Number(log.blockNumber), 1_700_000_000]]),
    priceContext: { priceObservations: new Map(), priceHistory: new Map() } };
}
