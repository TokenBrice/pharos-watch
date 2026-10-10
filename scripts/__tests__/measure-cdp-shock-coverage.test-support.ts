import { keccak256 } from "viem";
import { encodeShockAbiWord, type ShockCallJournal, type ShockEthCallSpec } from "../lib/mechanism-measurement/shock-journal";
import { getShockCoverageTarget } from "../lib/mechanism-measurement/shock-targets";
import { measureConfiguredShockCoverageTarget } from "../lib/mechanism-measurement/shock-measure";
import { ShockCoverageEvidenceV1Schema } from "../lib/mechanism-measurement/shock-schema";

/** One complete, deterministic Trove census exercises real producer and replay code. */
export async function makeShockReplayFixture() {
  const target = getShockCoverageTarget("lusd-liquity");
  if (!target || target.family !== "liquity-v1-shock-v1") throw new Error("Expected LUSD target");
  const addresses: Record<string, string> = {
    "token.troveManagerAddress": target.contracts.troveManager,
    "token.stabilityPoolAddress": target.contracts.stabilityPool,
    "troveManager.priceFeed": target.contracts.priceFeed,
    "troveManager.borrowerOperationsAddress": target.contracts.borrowerOperations,
    "troveManager.lusdToken": target.contracts.token,
    "collSurplusPool.troveManagerAddress": target.contracts.troveManager,
    "collSurplusPool.activePoolAddress": "0x0000000000000000000000000000000000000011",
    "troveManager.activePool": "0x0000000000000000000000000000000000000011",
  };
  for (const [index, name] of ["troveManager.sortedTroves", "troveManager.defaultPool", "priceFeed.priceAggregator", "priceFeed.tellorCaller", "priceAggregator.aggregator", "tellorCaller.tellor"].entries()) {
    addresses[name] = `0x${(index + 20).toString(16).padStart(40, "0")}`;
  }
  const owner = "0x0000000000000000000000000000000000000030";
  Object.assign(addresses, {
    "sortedTroves.getFirst": owner, "sortedTroves.getLast": owner,
    "troveManager.owner[0]": owner, "sortedTroves.prev[0]": `0x${"0".repeat(40)}`,
  });
  const wad = 10n ** 18n;
  const values: Record<string, bigint> = {
    "priceFeed.fetchPrice": 2000n * wad,
    "troveManager.getEntireSystemColl": 2n * wad,
    "troveManager.getEntireSystemDebt": 2000n * wad,
    "stabilityPool.getTotalLUSDDeposits": 1000n * wad,
    "troveManager.MCR": 11n * wad / 10n,
    "troveManager.CCR": 15n * wad / 10n,
    "troveManager.checkRecoveryMode": 0n,
    "troveManager.getTroveOwnersCount": 1n, "sortedTroves.getSize": 1n,
  };
  const caller: ShockCallJournal = {
    calls: [], codePins: [],
    async call(spec: ShockEthCallSpec) {
      let words: bigint[];
      if (spec.name === "troveManager.position[0]") words = [2000n * wad, 2n * wad, 0n, 0n];
      else if (addresses[spec.name]) words = [BigInt(addresses[spec.name]!)];
      else if (values[spec.name] !== undefined) words = [values[spec.name]!];
      else throw new Error(`Unconfigured fixture call ${spec.name}`);
      const returnData = `0x${words.map(encodeShockAbiWord).join("")}`;
      caller.calls.push({ name: spec.name, to: spec.to.toLowerCase(), signature: spec.signature, selector: spec.selector, callData: spec.selector + (spec.args ?? []).map(encodeShockAbiWord).join(""), returnData, decoded: "" });
      return returnData;
    },
    async batch(specs) { return Promise.all(specs.map((spec) => caller.call(spec))); },
    recordDecoded(decoded) { caller.calls[caller.calls.length - 1]!.decoded = decoded; },
    recordBatchDecoded(decoded) {
      decoded.forEach((value, index) => { caller.calls[caller.calls.length - decoded.length + index]!.decoded = value; });
    },
    async captureCode(spec) {
      const pin = { ...spec, address: spec.address.toLowerCase(), bytecode: "0x60006000", codeHash: keccak256("0x60006000") };
      caller.codePins.push(pin);
      return pin;
    },
    async captureCodes(specs) { return Promise.all(specs.map((spec) => caller.captureCode(spec))); },
  };
  const timestampUnix = Date.parse("2026-10-01T00:00:00Z") / 1000;
  return ShockCoverageEvidenceV1Schema.parse(await measureConfiguredShockCoverageTarget(caller, target, {
    number: 1, hash: `0x${"1".repeat(64)}`, timestampUnix,
    timestampIso: new Date(timestampUnix * 1000).toISOString(), selection: "operator-pinned",
  }, "https://example.invalid"));
}
