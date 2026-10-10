import type { MintBurnBridgeClassifiableRow, MintBurnTxContext } from "../mint-burn-bridge-classifier";
import type { MintBurnCcipBridgeDetectionConfig, MintBurnCctpBridgeDetectionConfig } from "../mint-burn-contracts";

export function makeBridgeRow(overrides: Partial<MintBurnBridgeClassifiableRow> = {}): MintBurnBridgeClassifiableRow {
  return {
    id: "row-1", tx_hash: "0xtx", direction: "burn", flow_type: "standard",
    counterparty: null, burn_type: null, burn_review_reason: null,
    ...overrides,
  };
}

export function signalContext(detection: MintBurnCcipBridgeDetectionConfig | MintBurnCctpBridgeDetectionConfig): MintBurnTxContext {
  return {
    to: detection.knownBridgeRouterAddresses[0],
    inputSelector: detection.bridgeSignalSelectors[0],
    logTopics: [detection.bridgeSignalTopics[0]],
    logAddresses: [detection.knownBridgeRouterAddresses[0]],
  };
}

/** Circle V2 receipt shape: token Transfer, MintAndWithdraw, MessageReceived. */
export function cctpReceiveContext(detection: MintBurnCctpBridgeDetectionConfig, fee = 0): MintBurnTxContext {
  const recipient = `0x${"0".repeat(24)}abcdef1234567890abcdef1234567890abcdef12`;
  const token = `0x${"0".repeat(24)}${detection.mintTokenAddress.slice(2).toLowerCase()}`;
  const messenger = `0x${"0".repeat(24)}${detection.knownBridgeRouterAddresses[0].slice(2).toLowerCase()}`;
  const amount = "00000000000000000000000000000000000000000000000000000002540be400";
  const word = (value: number) => value.toString(16).padStart(64, "0");
  const grossAmount = (BigInt(`0x${amount}`) + BigInt(fee)).toString(16).padStart(64, "0");
  const body = `00000001${token.slice(2)}${recipient.slice(2)}${grossAmount}${recipient.slice(2)}${word(fee)}${word(fee)}${word(0)}`;
  const receiptLogs = [
    {
      address: detection.mintTokenAddress,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${word(0)}`, recipient],
      data: `0x${amount}`,
      logIndex: "0x0",
    },
    {
      address: detection.knownBridgeRouterAddresses[0],
      topics: [detection.mintAndWithdrawTopic, recipient, token],
      data: `0x${amount}${word(fee)}`,
      logIndex: fee > 0 ? "0x2" : "0x1",
    },
    {
      address: detection.messageTransmitterAddress,
      topics: [detection.messageReceivedTopic, recipient, `0x${word(1)}`, `0x${word(2000)}`],
      data: `0x${word(1)}${messenger.slice(2)}${word(96)}${word(body.length / 2)}${body.padEnd(Math.ceil(body.length / 64) * 64, "0")}`,
      logIndex: fee > 0 ? "0x3" : "0x2",
    },
  ];
  if (fee > 0) {
    receiptLogs.splice(1, 0, {
      address: detection.mintTokenAddress,
      topics: [receiptLogs[0].topics[0], `0x${word(0)}`, `0x${"0".repeat(24)}1111111111111111111111111111111111111111`],
      data: `0x${word(fee)}`,
      logIndex: "0x1",
    });
  }
  return {
    to: detection.messageTransmitterAddress,
    inputSelector: "0x57ecfd28",
    logTopics: receiptLogs.flatMap((log) => log.topics),
    logAddresses: receiptLogs.map((log) => log.address),
    receiptLogs,
  };
}
