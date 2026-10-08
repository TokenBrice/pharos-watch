import { formatUnits, hexToString, keccak256, parseAbi, parseAbiItem } from "viem";
import {
  memoizeRead,
  requireScenarioChain,
  scenarioSourceAddress,
  type ScenarioCheck,
  type ScenarioCheckContext,
  type ScenarioCheckVerdict,
  type ScenarioCheckValue,
} from "./index";

const ABI = parseAbi([
  "function hat() view returns (address)",
  "function approvals(address candidate) view returns (uint256)",
  "function delay() view returns (uint256)",
  "function owner() view returns (address)",
  "function authority() view returns (address)",
  "function proxy() view returns (address)",
  "function min() view returns (uint256)",
  "function Sum() view returns (uint256)",
  "function gem() view returns (address)",
  "function end() view returns (address)",
  "function live() view returns (uint256)",
  "function wards(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function dai(address account) view returns (uint256)",
  "function sin(address account) view returns (uint256)",
  "function pocket() view returns (address)",
  "function psm() view returns (address)",
  "function usds() view returns (address)",
  "function vat() view returns (address)",
  "function dai() view returns (address)",
  "function daiJoin() view returns (address)",
  "function usdsJoin() view returns (address)",
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
  "function buf() view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function paused() view returns (bool)",
  "function isBlacklisted(address account) view returns (bool)",
  "function list() view returns (bytes32[])",
  "function getAddress(bytes32 key) view returns (address)",
  "function ilks(bytes32 ilk) view returns (uint256 Art, uint256 rate, uint256 spot, uint256 line, uint256 dust)",
  "function urns(bytes32 ilk, address urn) view returns (uint256 ink, uint256 art)",
  "function ilk() view returns (bytes32)",
  "function buffer() view returns (address)",
]);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO = "0x0000000000000000000000000000000000000000";

interface EsmState {
  min: bigint;
  staked: bigint;
  upperBound: bigint;
  gem: `0x${string}`;
  end: `0x${string}`;
  live: bigint;
  endLive: bigint;
  endWard: bigint;
}

interface VowBalances {
  credit: bigint;
  debt: bigint;
  net: bigint;
}

function baseline(context: ScenarioCheckContext, id: string): bigint {
  const block = context.record.falsifiers.find((entry) => entry.id === id)?.checkedAtBlock;
  if (block == null) throw new Error(`No recorded baseline block for ${id}`);
  return BigInt(block);
}

function condition(context: ScenarioCheckContext, id: string): string {
  const text = context.record.falsifiers.find((entry) => entry.id === id)?.condition;
  if (!text) throw new Error(`No recorded condition for ${id}`);
  return text;
}

async function code(context: ScenarioCheckContext, sourceId: string, blockNumber: bigint): Promise<`0x${string}`> {
  const { client } = requireScenarioChain(context);
  const bytecode = await client.getBytecode({ address: scenarioSourceAddress(context.record, sourceId), blockNumber });
  if (!bytecode || bytecode === "0x") throw new Error(`No runtime bytecode for ${sourceId} at ${blockNumber}`);
  return keccak256(bytecode);
}

function sourcePin(context: ScenarioCheckContext, sourceId: string): bigint {
  const block = context.record.sources.find((entry) => entry.id === sourceId)?.block;
  if (block == null) throw new Error(`No recorded source block for ${sourceId}`);
  return BigInt(block);
}

function name(key: `0x${string}`): string {
  return hexToString(key, { size: 32 }).replace(/\u0000+$/, "");
}

interface BookInventory {
  ilks: `0x${string}`[];
  allocators: Record<string, `0x${string}`>;
}
interface BookState extends BookInventory {
  positions: { key: string; vault: string; ilk: string; buffer: string; inkWad: string; debtRad: string; bufferUsdsWad: string }[];
  debts: { ilk: string; debtRad: bigint; lineRad: bigint }[];
}
// Do not let an unavailable debt/urn read erase the independent discovery of
// registered ilks and allocator identities. Reuse discovery at each chain pin.
function inventory(context: ScenarioCheckContext, blockNumber: bigint): Promise<BookInventory> {
  const chain = requireScenarioChain(context);
  return memoizeRead(context, `usds-book-inventory:1:${blockNumber}`, async () => {
    const { client } = chain;
    const registry = scenarioSourceAddress(context.record, "ils");
    const chainlog = scenarioSourceAddress(context.record, "chainlog");
    const ilks = [...await client.readContract({ address: registry, abi: ABI, functionName: "list", blockNumber })].sort();
    if (new Set(ilks).size !== ilks.length || ilks.length === 0) throw new Error("Ilk registry enumeration is empty or contains duplicates");
    const keys = (await client.readContract({ address: chainlog, abi: ABI, functionName: "list", blockNumber }))
      .filter((key) => /^ALLOCATOR_.*_(VAULT|BUFFER)$/.test(name(key))).sort();
    if (keys.length === 0) throw new Error("Chainlog contains no allocator vaults or buffers");
    const allocators: Record<string, `0x${string}`> = {};
    for (const key of keys) {
      allocators[name(key)] = (await client.readContract({ address: chainlog, abi: ABI, functionName: "getAddress", args: [key], blockNumber })).toLowerCase() as `0x${string}`;
    }
    return { ilks, allocators };
  });
}

async function book(context: ScenarioCheckContext, blockNumber: bigint): Promise<BookState> {
  const { client } = requireScenarioChain(context);
  const { ilks, allocators } = await inventory(context, blockNumber);
  const vat = scenarioSourceAddress(context.record, "vat");
  const debts: BookState["debts"] = [];
  for (const ilk of ilks) {
    try {
      const [art, rate, , line] = await client.readContract({ address: vat, abi: ABI, functionName: "ilks", args: [ilk], blockNumber });
      debts.push({ ilk: name(ilk), debtRad: art * rate, lineRad: line });
    } catch (error) {
      throw new Error(`Cannot measure registered ilk ${name(ilk)}: Vat.ilks at block ${blockNumber} needs a working historical eth_call provider. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const positions: BookState["positions"] = [];
  for (const [key, address] of Object.entries(allocators)) {
    if (!key.endsWith("_VAULT")) continue;
    try {
      const allocatorVat = await client.readContract({ address, abi: ABI, functionName: "vat", blockNumber });
      if (allocatorVat.toLowerCase() !== vat.toLowerCase()) throw new Error(`Allocator Vat ${allocatorVat} differs from the recorded shared-book Vat ${vat}`);
      const ilk = await client.readContract({ address, abi: ABI, functionName: "ilk", blockNumber });
      const buffer = await client.readContract({ address, abi: ABI, functionName: "buffer", blockNumber });
      const [ink, art] = await client.readContract({ address: vat, abi: ABI, functionName: "urns", args: [ilk, address], blockNumber });
      const [, rate] = await client.readContract({ address: vat, abi: ABI, functionName: "ilks", args: [ilk], blockNumber });
      const usds = await client.readContract({ address, abi: ABI, functionName: "usds", blockNumber });
      if (usds.toLowerCase() !== scenarioSourceAddress(context.record, "usds").toLowerCase()) throw new Error(`Allocator buffer token ${usds} differs from the recorded USDS`);
      const bufferUsds = await client.readContract({ address: usds, abi: ABI, functionName: "balanceOf", args: [buffer], blockNumber });
      positions.push({ key, vault: address, ilk: name(ilk), buffer: buffer.toLowerCase(), inkWad: ink.toString(), debtRad: (art * rate).toString(), bufferUsdsWad: bufferUsds.toString() });
    } catch (error) {
      throw new Error(`Cannot measure ${key} (${address}) at block ${blockNumber}: need vault ilk/buffer/usds getters, Vat urn debt and buffer balance before reporting allocator figures. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ilks, allocators, positions, debts };
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SELL_GEM = parseAbiItem("event SellGem(address indexed owner, uint256 value, uint256 fee)");

async function pocketInflows(context: ScenarioCheckContext): Promise<ScenarioCheckValue> {
  const { client, blockNumber } = requireScenarioChain(context);
  const psm = scenarioSourceAddress(context.record, "lite-psm");
  const usdc = scenarioSourceAddress(context.record, "usdc");
  const pocket = await client.readContract({ address: psm, abi: ABI, functionName: "pocket", blockNumber });
  const pin = await client.getBlock({ blockNumber });
  const target = pin.timestamp > 30n * 86_400n ? pin.timestamp - 30n * 86_400n : 0n;
  // Bracket the exact timestamp boundary using recent blocks before searching.
  // Starting at genesis would needlessly query remote archive history.
  let high = blockNumber;
  let low = blockNumber;
  let stride = 8_192n;
  while (low > 0n) {
    low = high > stride ? high - stride : 0n;
    if ((await client.getBlock({ blockNumber: low })).timestamp < target) break;
    high = low;
    stride *= 2n;
  }
  while (low < high) {
    const middle = (low + high) / 2n;
    if ((await client.getBlock({ blockNumber: middle })).timestamp < target) low = middle + 1n;
    else high = middle;
  }
  const fromBlock = low;
  const senders = new Map<string, { transfers: number; amount: bigint; swapped: bigint; minted: bigint; unmatched: bigint }>();
  let total = 0n;
  let count = 0;
  const unmatchedExamples: ScenarioCheckValue[] = [];
  for (let start = fromBlock; start <= blockNumber; start += 5_000n) {
    const end = start + 4_999n < blockNumber ? start + 4_999n : blockNumber;
    const transfers = await client.getLogs({ address: usdc, event: TRANSFER, args: { to: pocket }, fromBlock: start, toBlock: end, strict: true })
      .catch((error: unknown) => { throw new Error(`Thirty-day pocket census incomplete: USDC Transfer(to=${pocket}) failed for blocks ${start}-${end}. Supply a historical log provider serving this 5,000-block window; no partial census is accepted. ${error instanceof Error ? error.message : String(error)}`); });
    const sells = await client.getLogs({ address: psm, event: SELL_GEM, fromBlock: start, toBlock: end, strict: true })
      .catch((error: unknown) => { throw new Error(`Thirty-day pocket census incomplete: LitePSM SellGem failed for blocks ${start}-${end}. Supply a historical log provider serving this 5,000-block window; unmatched-transfer classification is unavailable without the complete swap events. ${error instanceof Error ? error.message : String(error)}`); });
    const used = new Set<string>();
    for (const transfer of transfers) {
      if (transfer.removed || transfer.logIndex === null || transfer.transactionHash === null) throw new Error("Pocket inflow log is removed or lacks mined identity");
      const sender = transfer.args.from.toLowerCase();
      const amount = transfer.args.value;
      const entry = senders.get(sender) ?? { transfers: 0, amount: 0n, swapped: 0n, minted: 0n, unmatched: 0n };
      // The reviewed LitePSM emits SellGem after transferFrom into the pocket.
      // Pair ordered equal-amount events one-to-one; never count a whole receipt
      // as a swap merely because it also contains a SellGem.
      const sell = sells.find((log) => !log.removed && log.transactionHash === transfer.transactionHash
        && log.logIndex !== null && log.logIndex > transfer.logIndex!
        && log.args.value === amount && !used.has(`${log.transactionHash}:${log.logIndex}`));
      // A donation before a real swap must not steal that swap's event.
      const paired = sell && !transfers.some((other) => other.transactionHash === transfer.transactionHash
        && other.logIndex !== null && other.logIndex > transfer.logIndex! && other.logIndex < sell.logIndex!);
      if (sender === ZERO) entry.minted += amount;
      else if (paired) {
        used.add(`${sell.transactionHash}:${sell.logIndex}`);
        entry.swapped += amount;
      } else {
        entry.unmatched += amount;
        if (unmatchedExamples.length < 10) unmatchedExamples.push({ sender, amountUsdcBaseUnits: amount.toString(), transactionHash: transfer.transactionHash, logIndex: transfer.logIndex });
      }
      entry.transfers++;
      entry.amount += amount;
      senders.set(sender, entry);
      count++;
      total += amount;
    }
  }
  return {
    fromBlock: fromBlock.toString(), throughBlock: blockNumber.toString(),
    fromTimestamp: (await client.getBlock({ blockNumber: fromBlock })).timestamp.toString(), throughTimestamp: pin.timestamp.toString(),
    token: usdc, pocket, transferCount: count, totalInflowUsdcBaseUnits: total.toString(),
    counterparties: [...senders].sort(([a], [b]) => a.localeCompare(b)).map(([sender, entry]) => ({
      sender, transferCount: entry.transfers, inflowUsdcBaseUnits: entry.amount.toString(),
      directMintUsdcBaseUnits: entry.minted.toString(), matchedSellGemUsdcBaseUnits: entry.swapped.toString(),
      unmatchedUsdcBaseUnits: entry.unmatched.toString(),
    })),
    unmatchedExamples, unmatchedExampleLimit: 10,
  };
}

const checks: readonly ScenarioCheck[] = [
  {
    id: "hat-approvals-bar",
    label: "Recorded hat and Chief-to-PauseProxy governance route",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const chief = scenarioSourceAddress(context.record, "chief");
      const pause = scenarioSourceAddress(context.record, "pause");
      const proxy = scenarioSourceAddress(context.record, "pause-proxy");
      const pin = baseline(context, "hat-approvals-bar");
      const recorded = {
        hat: scenarioSourceAddress(context.record, "sitting-hat").toLowerCase(),
        pauseOwner: ZERO, pauseAuthority: chief.toLowerCase(), pauseProxy: proxy.toLowerCase(), proxyOwner: pause.toLowerCase(),
        pauseCode: await code(context, "pause", pin), proxyCode: await code(context, "pause-proxy", pin),
      };
      const observed = {
        hat: (await client.readContract({ address: chief, abi: ABI, functionName: "hat", blockNumber })).toLowerCase(),
        pauseOwner: (await client.readContract({ address: pause, abi: ABI, functionName: "owner", blockNumber })).toLowerCase(),
        pauseAuthority: (await client.readContract({ address: pause, abi: ABI, functionName: "authority", blockNumber })).toLowerCase(),
        pauseProxy: (await client.readContract({ address: pause, abi: ABI, functionName: "proxy", blockNumber })).toLowerCase(),
        proxyOwner: (await client.readContract({ address: proxy, abi: ABI, functionName: "owner", blockNumber })).toLowerCase(),
        pauseCode: await code(context, "pause", blockNumber), proxyCode: await code(context, "pause-proxy", blockNumber),
      };
      return {
        verdict: JSON.stringify(recorded) === JSON.stringify(observed) ? "holds" : "changed", recorded, observed,
        reason: "Tests the named sitting hat, ownerless Chief-authorized Pause, recorded PauseProxy and its Pause owner, plus the reviewed execution runtimes. Live staking weight is a separate informational figure.",
      };
    },
  },
  {
    id: "hat-approvals-bar",
    label: "Chief.lift retains its strict-greater-than comparison",
    async run(context) {
      const { blockNumber } = requireScenarioChain(context);
      const recorded = await code(context, "chief", baseline(context, "hat-approvals-bar"));
      const observed = await code(context, "chief", blockNumber);
      return { verdict: recorded === observed ? "holds" : "changed", recorded, observed, reason: "The pinned immutable Chief requires approvals[candidate] > approvals[hat], not a majority of the entire SKY supply; changed code needs source review" };
    },
  },
  {
    id: "hat-approval-weight",
    kind: "figure",
    recordField: { collection: "keyFigures", label: "Approvals to beat" },
    label: "Live SKY approvals needed to outvote the sitting hat",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const chief = scenarioSourceAddress(context.record, "chief");
      const pin = sourcePin(context, "chief");
      const readWeight = async (block: bigint) => {
        const hat = await client.readContract({ address: chief, abi: ABI, functionName: "hat", blockNumber: block });
        const approvals = await client.readContract({ address: chief, abi: ABI, functionName: "approvals", args: [hat], blockNumber: block });
        return { hat: hat.toLowerCase(), approvalsWad: approvals.toString(), approvalsSky: formatUnits(approvals, 18) };
      };
      const previous = await readWeight(pin);
      const current = await readWeight(blockNumber);
      return {
        verdict: current.approvalsWad === previous.approvalsWad ? "holds" : "changed",
        recorded: { published: context.record.keyFigures.find((entry) => entry.label === "Approvals to beat")!.value, sourceBlock: pin.toString(), ...previous },
        observed: current,
        reason: "Exact approval-weight movement is informational, even if the rounded published figure is unchanged. Chief.lift requires strictly more than this live weight, not a frozen snapshot or a majority of supply.",
      };
    },
  },
  {
    id: "pause-delay",
    label: "DSPause delay and plot's earliest-eta enforcement",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const seconds = condition(context, "pause-delay").match(/below ([\d,]+) seconds/)?.[1];
      if (!seconds) throw new Error("No exact recorded pause delay");
      const minimum = BigInt(seconds.replaceAll(",", ""));
      const pin = baseline(context, "pause-delay");
      const recorded = { minimumDelaySeconds: minimum.toString(), code: await code(context, "pause", pin) };
      const actual = await client.readContract({ address: scenarioSourceAddress(context.record, "pause"), abi: ABI, functionName: "delay", blockNumber });
      const observed = { delaySeconds: actual.toString(), code: await code(context, "pause", blockNumber) };
      return { verdict: actual >= minimum && observed.code === recorded.code ? "holds" : "changed", recorded, observed, reason: "Unchanged recorded DSPause runtime enforces eta >= now + delay at plot and eta <= now at execution" };
    },
  },
  {
    id: "usds-holder-controls",
    label: "USDS proxy and implementation retain the reviewed holder controls",
    async run(context): Promise<ScenarioCheckVerdict> {
      const { client, blockNumber } = requireScenarioChain(context);
      const pin = baseline(context, "usds-holder-controls");
      const implementation = scenarioSourceAddress(context.record, "usds-impl").toLowerCase();
      const storage = await client.getStorageAt({ address: scenarioSourceAddress(context.record, "usds"), slot: IMPL_SLOT, blockNumber });
      if (!storage) throw new Error("USDS implementation slot unavailable");
      const observedImplementation = `0x${storage.slice(-40)}`.toLowerCase();
      if (observedImplementation !== implementation) return { verdict: "changed", recorded: implementation, observed: observedImplementation, reason: "USDS implementation changed; a human must inspect pause/freeze/blacklist/seizure and burn-allowance semantics before re-approval" };
      const recorded = { implementation, proxyCode: await code(context, "usds", pin), implementationCode: await code(context, "usds-impl", pin) };
      const observed = { implementation: observedImplementation, proxyCode: await code(context, "usds", blockNumber), implementationCode: await code(context, "usds-impl", blockNumber) };
      return { verdict: observed.proxyCode === recorded.proxyCode && observed.implementationCode === recorded.implementationCode ? "holds" : "changed", recorded, observed, reason: "Unchanged reviewed implementation has no holder pause/freeze/blacklist/admin seizure, and burning another holder's tokens requires allowance" };
    },
  },
  {
    id: "esm-can-fire",
    label: "ESM activation threshold against staked and potentially stakeable MKR",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "esm");
      const pin = baseline(context, "esm-can-fire");
      const readState = async (block: bigint): Promise<EsmState> => {
        const min = await client.readContract({ address, abi: ABI, functionName: "min", blockNumber: block });
        const staked = await client.readContract({ address, abi: ABI, functionName: "Sum", blockNumber: block });
        const gem = await client.readContract({ address, abi: ABI, functionName: "gem", blockNumber: block });
        const supply = await client.readContract({ address: gem, abi: ABI, functionName: "totalSupply", blockNumber: block });
        const held = await client.readContract({ address: gem, abi: ABI, functionName: "balanceOf", args: [address], blockNumber: block });
        if (held > supply) throw new Error("ESM MKR balance exceeds token supply");
        const end = await client.readContract({ address, abi: ABI, functionName: "end", blockNumber: block });
        const live = await client.readContract({ address, abi: ABI, functionName: "live", blockNumber: block });
        const endLive = await client.readContract({ address: end, abi: ABI, functionName: "live", blockNumber: block });
        const endWard = await client.readContract({ address: end, abi: ABI, functionName: "wards", args: [address], blockNumber: block });
        // Sum survives burn(), so adding totalSupply without subtracting MKR
        // already held here would double-count tokens that cannot be re-staked.
        const upperBound = staked + supply - held;
        return { min, staked, upperBound, gem, end, live, endLive, endWard };
      };
      const previous = await readState(pin);
      const current = await readState(blockNumber);
      const values = (state: EsmState) => ({
        min: state.min.toString(), stakedMkrWad: state.staked.toString(), reachableMkrUpperBoundWad: state.upperBound.toString(),
        gem: state.gem, end: state.end, live: state.live.toString(), endLive: state.endLive.toString(), endWard: state.endWard.toString(),
      });
      const recorded = { ...values(previous), code: await code(context, "esm", pin) };
      const observed = { ...values(current), code: await code(context, "esm", blockNumber) };
      const wiringChanged = current.gem.toLowerCase() !== previous.gem.toLowerCase() || current.end.toLowerCase() !== previous.end.toLowerCase();
      const reachable = current.live === 1n && current.endLive === 1n && current.endWard === 1n && current.min <= current.upperBound;
      return {
        verdict: observed.code !== recorded.code || wiringChanged || reachable ? "changed" : "holds", recorded, observed,
        reason: current.min > current.upperBound
          ? "Even staking every remaining MKR cannot reach min; the supply-based upper bound is deliberately generous"
          : current.staked >= current.min && current.live === 1n && current.endLive === 1n && current.endWard === 1n
            ? "The live ESM already has enough staked MKR and is an End ward"
            : "Threshold is no longer ruled out by supply alone; human review must establish accessible MKR and shutdown wiring, not assume all supply is liquid",
      };
    },
  },
  {
    id: "spell-veto",
    label: "Queued-spell cancellation remains gated only to the Chief hat",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const pin = baseline(context, "spell-veto");
      const address = scenarioSourceAddress(context.record, "pause");
      const recorded = { owner: ZERO, authority: scenarioSourceAddress(context.record, "chief").toLowerCase(), pauseCode: await code(context, "pause", pin), authorityCode: await code(context, "chief", pin) };
      const observed = {
        owner: (await client.readContract({ address, abi: ABI, functionName: "owner", blockNumber })).toLowerCase(),
        authority: (await client.readContract({ address, abi: ABI, functionName: "authority", blockNumber })).toLowerCase(),
        pauseCode: await code(context, "pause", blockNumber), authorityCode: await code(context, "chief", blockNumber),
      };
      return { verdict: observed.owner === recorded.owner && observed.authority === recorded.authority && observed.pauseCode === recorded.pauseCode && observed.authorityCode === recorded.authorityCode ? "holds" : "changed", recorded, observed, reason: "DSPause.drop is auth-gated; unchanged Chief.canCall permits only the current hat. A new owner/authority or runtime requires veto review" };
    },
  },
  {
    id: "vow-surplus",
    label: "Vow credit against its recognised debt",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "vat");
      const vow = scenarioSourceAddress(context.record, "vow");
      const readBalances = async (block: bigint): Promise<VowBalances> => {
        const credit = await client.readContract({ address, abi: ABI, functionName: "dai", args: [vow], blockNumber: block });
        const debt = await client.readContract({ address, abi: ABI, functionName: "sin", args: [vow], blockNumber: block });
        return { credit, debt, net: credit - debt };
      };
      const previous = await readBalances(baseline(context, "vow-surplus"));
      const current = await readBalances(blockNumber);
      const values = (state: VowBalances) => ({ creditRad: state.credit.toString(), recognisedDebtRad: state.debt.toString(), netRad: state.net.toString() });
      return { verdict: current.net > 0n ? "changed" : "holds", recorded: values(previous), observed: values(current), reason: "Positive net credit needs review: the record supplies no numerical liquidation-gap threshold. Non-positive net credit is still no surplus; queued Sin is already included in Vat.sin and must not be added twice" };
    },
  },
  {
    id: "litepsm-non-circle-usdc",
    label: "LitePSM exit asset remains the recorded Circle USDC",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const psm = scenarioSourceAddress(context.record, "lite-psm");
      const wrapper = scenarioSourceAddress(context.record, "psm-wrapper");
      const pin = sourcePin(context, "lite-psm");
      const recorded = {
        gem: scenarioSourceAddress(context.record, "usdc").toLowerCase(), psm: psm.toLowerCase(),
        psmCode: await code(context, "lite-psm", pin), wrapperCode: await code(context, "psm-wrapper", pin),
      };
      const observed = {
        gem: (await client.readContract({ address: psm, abi: ABI, functionName: "gem", blockNumber })).toLowerCase(),
        wrapperGem: (await client.readContract({ address: wrapper, abi: ABI, functionName: "gem", blockNumber })).toLowerCase(),
        psm: (await client.readContract({ address: wrapper, abi: ABI, functionName: "psm", blockNumber })).toLowerCase(),
        psmCode: await code(context, "lite-psm", blockNumber), wrapperCode: await code(context, "psm-wrapper", blockNumber),
      };
      return {
        verdict: observed.gem === recorded.gem && observed.wrapperGem === recorded.gem && observed.psm === recorded.psm
          && observed.psmCode === recorded.psmCode && observed.wrapperCode === recorded.wrapperCode ? "holds" : "changed",
        recorded, observed,
        reason: "Establishes only the unchanged USDC-denominated exit path. Every transfer of this token retains its issuer dependency; a different sending address is not an independent issuer or a guarantee of replenishment.",
      };
    },
  },
  {
    id: "litepsm-non-circle-usdc",
    label: "Pocket inventory remains the zero-fee cash-exit ceiling",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const psm = scenarioSourceAddress(context.record, "lite-psm");
      const usdc = scenarioSourceAddress(context.record, "usdc");
      const pocket = await client.readContract({ address: psm, abi: ABI, functionName: "pocket", blockNumber });
      const previousPocket = await client.readContract({ address: psm, abi: ABI, functionName: "pocket", blockNumber: sourcePin(context, "lite-psm") });
      const balance = await client.readContract({ address: usdc, abi: ABI, functionName: "balanceOf", args: [pocket], blockNumber });
      const usdsSupply = await client.readContract({ address: scenarioSourceAddress(context.record, "usds"), abi: ABI, functionName: "totalSupply", blockNumber });
      const allowance = await client.readContract({ address: usdc, abi: ABI, functionName: "allowance", args: [pocket, psm], blockNumber });
      const tout = await client.readContract({ address: psm, abi: ABI, functionName: "tout", blockNumber });
      const paused = await client.readContract({ address: usdc, abi: ABI, functionName: "paused", blockNumber });
      const blacklisted = await client.readContract({ address: usdc, abi: ABI, functionName: "isBlacklisted", args: [pocket], blockNumber });
      const psmBlacklisted = await client.readContract({ address: usdc, abi: ABI, functionName: "isBlacklisted", args: [psm], blockNumber });
      const vat = await client.readContract({ address: psm, abi: ABI, functionName: "vat", blockNumber });
      const live = await client.readContract({ address: vat, abi: ABI, functionName: "live", blockNumber });
      const pin = sourcePin(context, "lite-psm");
      const recorded = {
        pocket: previousPocket.toLowerCase(),
        toutWad: (await client.readContract({ address: psm, abi: ABI, functionName: "tout", blockNumber: pin })).toString(),
        psmCode: await code(context, "lite-psm", pin), wrapperCode: await code(context, "psm-wrapper", pin),
      };
      const observed = {
        pocket: pocket.toLowerCase(), pocketUsdcBaseUnits: balance.toString(), allowanceUsdcBaseUnits: allowance.toString(),
        usdsSupplyWad: usdsSupply.toString(),
        toutWad: tout.toString(), paused, pocketBlacklisted: blacklisted, psmBlacklisted, vatLive: live.toString(),
        psmCode: await code(context, "lite-psm", blockNumber), wrapperCode: await code(context, "psm-wrapper", blockNumber),
      };
      return {
        verdict: observed.pocket === recorded.pocket && tout === 0n && recorded.toutWad === "0" && allowance >= balance
          && !paused && !blacklisted && !psmBlacklisted && live === 1n && balance * 10n ** 12n < usdsSupply
          && observed.psmCode === recorded.psmCode && observed.wrapperCode === recorded.wrapperCode ? "holds" : "changed",
        recorded, observed,
        reason: "Tests the reviewed pocket-only buyGem runtime, zero exit fee, sufficient pocket allowance, issuer/Vat availability and USDC inventory below USDS supply. The instantaneous inventory ceiling is conditional on a funded/approved holder and the USDS/join path; it guarantees neither future inflows, holder access nor post-capture solvency. A restriction makes inventory alone insufficient, while enough inventory to cover all USDS removes this particular binding bound.",
      };
    },
  },
  {
    id: "litepsm-cash-at-par",
    kind: "figure",
    recordField: { collection: "keyFigures", label: "Cash available at par" },
    label: "LitePSM pocket balance against the published cash figure",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const published = context.record.keyFigures.find((entry) => entry.label === "Cash available at par")!.value;
      const match = published.match(/^([\d.]+)bn USDC$/);
      if (!match) throw new Error(`Cannot parse recorded cash figure: ${published}`);
      const psm = scenarioSourceAddress(context.record, "lite-psm");
      const pocket = await client.readContract({ address: psm, abi: ABI, functionName: "pocket", blockNumber });
      const balance = await client.readContract({ address: scenarioSourceAddress(context.record, "usdc"), abi: ABI, functionName: "balanceOf", args: [pocket], blockNumber });
      const precision = match[1].split(".")[1]?.length ?? 0;
      const denominator = 10n ** BigInt(15 - precision);
      const rounded = (balance + denominator / 2n) / denominator;
      const recorded = BigInt(match[1].replace(".", ""));
      return {
        verdict: rounded === recorded ? "holds" : "changed",
        recorded: published, observed: { pocket, balanceUsdcBaseUnits: balance.toString(), billionUsdc: (Number(balance) / 1e15).toFixed(precision) },
        reason: "Rounded to the precision of the record's key figure; availability restrictions are reported separately.",
      };
    },
  },
  {
    id: "litepsm-recent-inflows",
    kind: "observation",
    label: "Thirty-day USDC pocket inflows and immediate counterparties",
    async run(context) {
      const { blockNumber } = requireScenarioChain(context);
      if (await code(context, "lite-psm", blockNumber) !== await code(context, "lite-psm", sourcePin(context, "lite-psm"))) {
        return { verdict: "unavailable", reason: "LitePSM runtime changed: review SellGem transfer/event semantics before classifying the 30-day inflows." };
      }
      return {
        verdict: "holds", recorded: { sourceBlock: sourcePin(context, "lite-psm").toString(), windowDays: 30 },
        observed: await pocketInflows(context),
        reason: "Complete bounded-window immediate inflows, classified as direct zero-address mints, paired LitePSM SellGem transfers, or unmatched transfers. SellGem owner is the DAI recipient, not necessarily the USDC sender. Unmatched is not evidence of an independent source, and swap senders can themselves be funded by Circle or intermediaries. No lifetime token provenance is inferred.",
      };
    },
  },
  {
    id: "litepsm-non-circle-usdc",
    label: "Documentary independence of LitePSM replenishment",
    async run() {
      return {
        verdict: "unavailable",
        reason: "Obtain a dated Sky LitePSM replenishment disclosure and any counterparty financing/custody agreement mapping the reported unmatched-transfer transaction hashes and swap senders to the beneficial funding party, reserve asset and enforceable replenishment obligation. The unknown is whether any economically independent reserve/backstop funds exits despite Circle impairment; the 30-day Transfer/SellGem census proves immediate token movements only. A third-party sender of Circle USDC does not remove Circle issuance, redemption or blacklist dependence.",
      };
    },
  },
  {
    id: "book-look-through",
    label: "Registered ilks and allocator vault/buffer identities against the record's pin",
    async run(context) {
      const { blockNumber } = requireScenarioChain(context);
      const previous = await inventory(context, sourcePin(context, "ils"));
      const current = await inventory(context, blockNumber);
      const recorded = { ilks: previous.ilks.map(name), allocators: previous.allocators };
      const observed = { ilks: current.ilks.map(name), allocators: current.allocators };
      return {
        verdict: JSON.stringify(recorded) === JSON.stringify(observed) ? "holds" : "changed", recorded, observed,
        reason: "Tests the chain-visible inventory of registered ilks and Chainlog allocator vault/buffer addresses only. New, removed or replaced entries require renewed look-through; unchanged entries do not establish named underlying assets. Unregistered positions and within-allocator deployments remain outside this enumeration.",
      };
    },
  },
  {
    id: "shared-book-positions",
    kind: "figure",
    recordField: { collection: "exposure", label: "Shared collateral book" },
    label: "Shared ilk debt weights and allocator positions",
    async run(context) {
      const { blockNumber } = requireScenarioChain(context);
      const published = context.record.exposure.find((entry) => entry.label === "Shared collateral book")!.detail;
      const current = await book(context, blockNumber);
      const previous = await book(context, sourcePin(context, "ils"));
      const total = current.debts.reduce((sum, entry) => sum + entry.debtRad, 0n);
      if (total === 0n) throw new Error("Registered ilk book has zero debt; no debt-share denominator");
      const weights = current.debts.map((entry) => ({
        ilk: entry.ilk, debtRad: entry.debtRad.toString(), debtCeilingRad: entry.lineRad.toString(),
        sharePercent: Number((entry.debtRad * 1_000n + total / 2n) / total) / 10,
      }));
      const publishedShares = [...published.matchAll(/([\d.]+)% (LitePSM USDC|Spark|Bloom|Grove)/g)];
      if (publishedShares.length !== 4) throw new Error("Shared collateral book does not contain four parseable recorded debt shares");
      const groups: Record<string, string> = { "LitePSM USDC": "LITE-PSM-USDC-A", Spark: "ALLOCATOR-SPARK-A", Bloom: "ALLOCATOR-BLOOM-A", Grove: "ALLOCATOR-GROVE-A" };
      const sharesMatch = publishedShares.every((match) => weights.find((entry) => entry.ilk === groups[match[2]])?.sharePercent === Number(match[1]));
      const count = published.match(/([\d,]+) ilks/);
      const publishedTotal = published.match(/carried \$([\d,.]+)bn of Vat debt/);
      if (!count || !publishedTotal) throw new Error("Shared collateral book lacks a parseable ilk count or total debt figure");
      const currentBn = (Number(total) / 1e54).toFixed(publishedTotal[1].split(".")[1]?.length ?? 0);
      const positionsMatch = JSON.stringify(previous.positions) === JSON.stringify(current.positions);
      return {
        verdict: sharesMatch && Number(count[1].replaceAll(",", "")) === current.ilks.length
          && currentBn === publishedTotal[1].replaceAll(",", "") && positionsMatch ? "holds" : "changed",
        recorded: { published, sourceBlock: sourcePin(context, "ils").toString(), allocatorPositions: previous.positions },
        observed: { block: blockNumber.toString(), ilkCount: current.ilks.length, totalIlkDebtRad: total.toString(), totalIlkDebtBillionUsd: currentBn, ilkWeights: weights, allocatorPositions: current.positions },
        reason: "Vat Art * rate is rad (10^45 units/USD); weights divide by summed registered ilk debt, not USDS supply. Vault urn debt and buffer USDS are current allocator positions, not a valuation of deployed assets. Exact allocator-position drift and published rounding/count/total drift are informational, never a verdict of full economic look-through.",
      };
    },
  },
  {
    id: "book-look-through",
    label: "Documentary reconciliation of Spark, Bloom and Grove deployments",
    async run() {
      return {
        verdict: "unavailable",
        reason: "Reconcile each reported Spark, Bloom and Grove vault urn debt and buffer balance with dated Prime Agent deployment schedules in Sky Ecosystem Financial Insights (https://financial.skyeco.com/) and the agents' asset-level disclosures. For every deployed dollar, require the named token/fund/security or borrower, allocation amount, custodian and legal obligor/holder claim, including off-chain and cross-chain positions and any leverage. The unknown is the reconciliation of these underlying assets and claims to allocator debt; Chainlog names, Vat urns and shared-book debt weights do not enumerate those assets or prove coverage.",
      };
    },
  },
];

export default checks;
