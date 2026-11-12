import { afterEach, describe, expect, it } from "vitest";
import { classifyBridgeAwareBurnRows } from "../mint-burn-bridge-classifier";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { BRIDGE_TOPICS } from "../mint-burn-bridge-classifier-protocols";
import { BRIDGE_RECEIPTS, makeBridgeRow, rebindReceipt, receiptConfig, receiptContext, receiptRows, type BridgeReceipt } from "./mint-burn-bridge-classifier.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { collectAffectedHours, persistMintBurnRows, recalcAffectedHours } from "../mint-burn-pipeline/persistence";
import type { MintBurnRow } from "../mint-burn-pipeline/types";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
const zero = `0x${"0".repeat(64)}`;
const other = "0x1111111111111111111111111111111111111111";
const bridgeConfigs = MINT_BURN_CONFIGS.filter((config) => config.bridgeDetection);
const sample = (name: string) => structuredClone(BRIDGE_RECEIPTS.find((fixture) => fixture.name === name)!);
const logFor = (fixture: BridgeReceipt, key: string) => fixture.logs.find((log) => log.topics[0] === key || log.logIndex === key)!;
const word = (amount: bigint) => amount.toString(16).padStart(64, "0");
const arrange = (name: string) => {
  const fixture = sample(name), config = receiptConfig(fixture, bridgeConfigs);
  return { fixture, config, rows: receiptRows(fixture, config) };
};
const classify = (fixture: BridgeReceipt, config: typeof bridgeConfigs[number], rows: Parameters<typeof classifyBridgeAwareBurnRows>[0]) =>
  classifyBridgeAwareBurnRows(rows, config.bridgeDetection, new Map([[fixture.transactionHash, receiptContext(fixture)]]));

describe("receipt-bound bridge classification", () => {
  it("classifies every real receipt by version, token, direction and movement identity", () => {
    for (const fixture of BRIDGE_RECEIPTS) {
      const { config, rows } = arrange(fixture.name);
      expect(rows.length, fixture.name).toBeGreaterThan(0);
      classify(fixture, config, rows);
      for (const row of rows) {
        const economic = fixture.name.startsWith("native-") || fixture.name === "economic-burn" || (fixture.name === "usdai-wrapped-mixed" && row.direction === "mint");
        expect(row.flow_type, `${fixture.name}:${row.id}`).toBe(economic ? "standard" : "bridge_transfer");
        expect(row.burn_type, fixture.name).toBe(row.direction === "mint" ? null : economic ? "effective_burn" : "bridge_burn");
        expect(row.bridge_review_reason, fixture.name).toBeNull();
      }
    }
  });

  it("requires receipt evidence for every configured bridge, including unresolved mints", () => {
    for (const config of bridgeConfigs) {
      const detection = config.bridgeDetection!;
      expect(detection.tokenAddress.toLowerCase()).toBe(config.contractAddress.toLowerCase());
      const pool = detection.protocol === "layerzero-oft" ? detection.knownBridgeContractAddresses[0] : detection.knownBridgePoolAddresses[0];
      for (const direction of ["mint", "burn"] as const) {
        const row = makeBridgeRow({ direction, counterparty: pool });
        classifyBridgeAwareBurnRows([row], detection, new Map([[row.tx_hash, { to: pool, inputSelector: "0xc7c7f5b3", logTopics: Object.values(BRIDGE_TOPICS), logAddresses: [pool], receiptLogs: [] }]]));
        expect(row.flow_type, config.stablecoinId).toBe("standard");
        expect(row.bridge_review_reason, config.stablecoinId).toBe("known-bridge-pool-without-bridge-signal");
        expect(row.burn_type).toBe("review_required");
        classifyBridgeAwareBurnRows([row], detection, new Map([[row.tx_hash, null]]));
        expect(row.bridge_review_reason).toBe("tx-context-unavailable");
      }
    }
  });

  it("covers every bridge config positively, with explicitly synthetic EURC and GLDon send evidence", () => {
    for (const config of bridgeConfigs) {
      const originals = config.stablecoinId === "eurc-circle"
        ? BRIDGE_RECEIPTS.filter((fixture) => ["v1-send-direct", "v1-receive-direct", "v2-send-direct", "v2-receive"].includes(fixture.name))
        : config.stablecoinId === "gldon-ondo" ? [sample("usdai-send")]
          : BRIDGE_RECEIPTS.filter((fixture) => receiptConfig(fixture, bridgeConfigs) === config && !fixture.name.startsWith("native-") && fixture.name !== "economic-burn");
      expect(originals.length, config.stablecoinId).toBeGreaterThan(0);
      for (const original of originals) {
        const source = receiptConfig(original, bridgeConfigs), fixture = source === config ? original : rebindReceipt(original, source, config);
        const rows = receiptRows(fixture, config);
        classify(fixture, config, rows);
        expect(rows.some((row) => row.flow_type === "bridge_transfer"), fixture.name).toBe(true);
      }
    }
  });

  it.each(["wrong-emitter", "other-token", "other-amount", "other-account", "other-row-id", "duplicate-log-index", "no-receipt", "one-proof"] as const)(
    "rejects %s evidence without suppressing unrelated movements", (mutation) => {
      for (const original of BRIDGE_RECEIPTS.filter((fixture) => fixture.name !== "economic-burn")) {
        const { config, fixture } = arrange(original.name);
        if (mutation === "one-proof") {
          if (!fixture.name.startsWith("native-")) continue;
          fixture.logs.unshift({ ...fixture.logs[0], logIndex: "0x0" });
        }
        const rows = receiptRows(fixture, config), ctx = receiptContext(fixture);
        const tokenAddress = config.contractAddress.toLowerCase();
        if (mutation === "wrong-emitter") for (const log of fixture.logs) { if (log.address.toLowerCase() !== tokenAddress) log.address = other; }
        if (mutation === "other-token") for (const log of fixture.logs) { if (log.address.toLowerCase() === tokenAddress) log.address = other; }
        if (mutation === "other-amount") for (const log of fixture.logs) { if (log.address.toLowerCase() === tokenAddress && log.topics[0] === BRIDGE_TOPICS.transfer) log.data = `0x${word(BigInt(log.data) + 1n)}`; }
        if (mutation === "other-account") for (const row of rows) row.counterparty = other;
        if (mutation === "other-row-id") for (const row of rows) row.id += "-99999";
        if (mutation === "duplicate-log-index") fixture.logs.push({ ...fixture.logs[0] });
        if (mutation === "no-receipt") delete ctx.receiptLogs;
        classifyBridgeAwareBurnRows(rows, config.bridgeDetection, new Map([[fixture.transactionHash, ctx]]));
        expect(rows.every((row) => row.flow_type === "standard"), `${original.name}:${mutation}`).toBe(true);
        if (fixture.name.startsWith("native-") && mutation !== "other-account")
          expect(rows.map((row) => row.burn_type), mutation).toEqual(mutation === "one-proof"
            ? ["review_required", rows[1].direction === "burn" ? "effective_burn" : null] : ["review_required"]);
      }
    },
  );

  it("does not pair LayerZero endpoint topics and emitters from different logs or another route", () => {
    for (const mutation of ["split-topic-emitter", "route", "guid", "wrong-direction"] as const) {
      const { fixture, config, rows } = arrange("usdai-executor-receive");
      const endpoint = logFor(fixture, BRIDGE_TOPICS.packetDelivered);
      if (mutation === "split-topic-emitter") { const emitter = endpoint.address; endpoint.address = other; fixture.logs.push({ address: emitter, topics: [zero], data: "0x", logIndex: "0xffff" }); }
      if (mutation === "route") endpoint.data = endpoint.data.slice(0, -40) + other.slice(2);
      if (mutation === "guid") logFor(fixture, BRIDGE_TOPICS.oftReceived).topics[1] = zero;
      if (mutation === "wrong-direction") logFor(fixture, BRIDGE_TOPICS.transfer).topics[1] = other.padEnd(66, "0");
      classify(fixture, config, rows);
      expect(rows[0].flow_type, mutation).toBe("standard");
    }
  });

  it("binds CCTP fee mints to the reviewed minter and leaves same-amount unrelated rows standard", () => {
    const { fixture, config } = arrange("v2-receive-fee");
    const unrelated = { ...structuredClone(logFor(fixture, "0x4")), logIndex: "0x0" };
    fixture.logs.unshift(unrelated);
    const rows = receiptRows(fixture, config);
    classify(fixture, config, rows);
    expect(rows.map((row) => row.flow_type)).toEqual(["standard", "bridge_transfer", "bridge_transfer"]);
    logFor(fixture, "0x3").topics[1] = `0x${other.slice(2).padStart(64, "0")}`;
    classify(fixture, config, rows);
    expect(rows.map((row) => row.flow_type)).toEqual(["standard", "bridge_transfer", "standard"]);
    expect(rows[2].bridge_review_reason).toBeNull();
  });

  it.each(["v1-receive-direct", "native-burn", "native-mint"])("requires proof for %s", (name) => {
    const { fixture, config, rows } = arrange(name);
    if (name === "v1-receive-direct") {
      fixture.logs = fixture.logs.filter((log) => log.topics[0] !== BRIDGE_TOPICS.cctpV1Mint);
    } else fixture.logs.pop();
    classify(fixture, config, rows);
    expect(rows[0]).toMatchObject({ flow_type: "standard", burn_type: "review_required", bridge_review_reason: "known-bridge-pool-without-bridge-signal" });
  });

  it("uses exact checked USDO arithmetic and cannot reuse a CCTP deposit's funding", () => {
    for (const overflow of [false, true]) {
      const { fixture, config } = arrange("usdo-receive-custom");
      const event = logFor(fixture, BRIDGE_TOPICS.ccipUsdoMinted);
      const recipient = event.data.slice(2, 66), sourceAmount = overflow ? 2n ** 255n : 5n;
      const sourceMultiplier = overflow ? 3n : 2n, destinationMultiplier = overflow ? 2n : 3n;
      const amount = sourceAmount * destinationMultiplier / sourceMultiplier;
      event.data = `0x${recipient}${word(sourceAmount)}${word(amount - 1n)}${word(sourceMultiplier)}${word(destinationMultiplier)}`;
      fixture.logs.find((log) => log.address.toLowerCase() === config.contractAddress.toLowerCase() && log.topics[0] === BRIDGE_TOPICS.transfer)!.data = `0x${word(amount)}`;
      const rows = receiptRows(fixture, config);
      classify(fixture, config, rows);
      expect(rows[0].flow_type).toBe(overflow ? "standard" : "bridge_transfer");
    }
    const { fixture, config } = arrange("v1-send-direct");
    const duplicate = (signature: string, index: string) => ({ ...structuredClone(logFor(fixture, signature)), logIndex: index });
    const deposit = fixture.logs[fixture.logs.length - 1];
    fixture.logs.push(duplicate(BRIDGE_TOPICS.burn, "0xfffd"), { ...structuredClone(fixture.logs.find((log) => log.topics[2] === zero)!), logIndex: "0xfffe" },
      duplicate(BRIDGE_TOPICS.messageSent, "0xffff"), { ...structuredClone(deposit), logIndex: "0x10000" });
    const rows = receiptRows(fixture, config);
    classify(fixture, config, rows);
    expect(rows.map((row) => row.flow_type)).toEqual(["bridge_transfer", "standard"]);
    expect(rows[1].burn_type).toBe("review_required");
  });

  it("preserves mint uncertainty and operation order under malformed or incomplete bridge evidence", () => {
    for (const mutation of ["equal-fee", "invalid-data", "unaligned-unrelated-log", "invalid-message", "missing-packet", "zero-recipient"] as const) {
      const fixture = sample(mutation === "missing-packet" ? "usdai-executor-receive" : mutation === "zero-recipient" ? "gldon-receive" : "v2-receive-fee");
      const config = receiptConfig(fixture, bridgeConfigs);
      if (mutation === "equal-fee") {
        const principal = logFor(fixture, "0x2"), fee = logFor(fixture, "0x4");
        fee.data = principal.data; fee.topics[2] = principal.topics[2];
        const feeMint = logFor(fixture, "0x3");
        feeMint.data = principal.data; feeMint.topics[2] = principal.topics[2];
        logFor(fixture, "0x5").data = principal.data + principal.data.slice(2);
      }
      if (mutation === "invalid-data" || mutation === "unaligned-unrelated-log") fixture.logs.push({ address: other, topics: [], data: mutation === "invalid-data" ? "0xz" : "0x01", logIndex: "0xffff" });
      if (mutation === "invalid-message") logFor(fixture, BRIDGE_TOPICS.cctpV2Received).data = "0x";
      if (mutation === "missing-packet") fixture.logs = fixture.logs.filter((log) => log.topics[0] !== BRIDGE_TOPICS.packetDelivered);
      if (mutation === "zero-recipient") {
        logFor(fixture, BRIDGE_TOPICS.oftReceived).topics[2] = zero;
        logFor(fixture, BRIDGE_TOPICS.transfer).topics[2] = `0x${"0".repeat(60)}dead`;
      }
      const rows = receiptRows(fixture, config);
      classify(fixture, config, rows);
      const unresolved = ["invalid-data", "invalid-message", "missing-packet"].includes(mutation);
      expect(rows.every((row) => row.flow_type === (unresolved ? "standard" : "bridge_transfer")), mutation).toBe(true);
      expect(rows.every((row) => unresolved ? row.bridge_review_reason != null : row.bridge_review_reason === null), mutation).toBe(true);
    }
  });

  it.each([["usdai-wrapped-mixed", 1, 0, 10000], ["native-burn", 0, 1, -10000], ["native-mint", 1, 0, 10000]] as const)("counts %s in hourly flows", async (name, mints, burns, net) => {
    const { fixture, config } = arrange(name);
    const rows: MintBurnRow[] = receiptRows(fixture, config).map((row) => ({ ...row,
      stablecoin_id: config.stablecoinId, symbol: config.symbol, chain_id: config.chain.chainId,
      amount: 10000, amount_raw: "10000000000", below_display_threshold: 0, amount_usd: 10000, price_used: 1, price_timestamp: 3601, price_source: "supply-history",
      block_number: fixture.blockNumber, timestamp: 3601, explorer_tx_url: `https://arbiscan.io/tx/${fixture.transactionHash}` }));
    classify(fixture, config, rows);
    const { sqlite, db } = fixtures.open(), affected = collectAffectedHours(rows);
    // Persist separately to isolate the independent roundtrip policy.
    for (const row of rows) await persistMintBurnRows(db, [row], affected);
    await recalcAffectedHours(db, affected);
    expect(sqlite.prepare("SELECT mint_count, burn_count, net_flow_usd FROM mint_burn_hourly").get()).toEqual({ mint_count: mints, burn_count: burns, net_flow_usd: net });
  });

  it("treats burns without a configured bridge as effective", () => {
    const row = makeBridgeRow();
    classifyBridgeAwareBurnRows([row], undefined, new Map());
    expect(row.burn_type).toBe("effective_burn");
  });
});
