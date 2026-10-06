import { z } from "zod";
import { CanonicalChainIdSchema, CanonicalTextSchema, Sha256Schema, UnixSecondsSchema } from "./safety-schema-primitives";

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Word = z.string().regex(/^0x[0-9a-f]{64}$/);
const Uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) < 2n ** 256n);
const Hex = z.string().max(16386).regex(/^0x[0-9a-f]*$/).refine(value => value.length % 2 === 0);
const common = {
  kind: z.literal("evm-l2-messenger-pending"), sourceId: CanonicalTextSchema,
  chainId: CanonicalChainIdSchema, l2ChainId: CanonicalChainIdSchema, finality: z.literal("finalized"),
  l1Token: Address, l2Token: Address, l1Bridge: Address, l2Bridge: Address, escrowAddress: Address,
  // Reviewed first token-bridge activation. Zero escrow/receipt state at the
  // predecessors is checked on-chain before an empty checkpoint is initialized.
  l1StartBlock: z.number().int().positive(), l2StartBlock: z.number().int().positive(),
  // Separate widths let sparse, fast L2 histories catch up without asking the
  // much denser L1 messenger for an unbounded log response.
  scanPageBlocks: z.tuple([z.number().int().positive().max(50000), z.number().int().positive().max(50000)]),
  contracts: z.array(z.strictObject({ chainId: CanonicalChainIdSchema, address: Address, runtimeCodeSha256: Sha256Schema })).min(4).max(24),
  // Includes reviewed implementation-slot/getter bindings for upgradeable
  // producers. Proxy runtime alone does not authenticate an implementation.
  identityReads: z.array(z.strictObject({ chainId: CanonicalChainIdSchema, address: Address,
    method: z.enum(["eth_call", "eth_getStorageAt"]), data: Hex, expected: Hex })).min(1).max(32),
};
export const L2MessengerPendingReadSchema = z.discriminatedUnion("protocol", [
  z.strictObject({ ...common, protocol: z.literal("op-stack"), bridgeFlavor: z.enum(["standard", "sky"]),
    l1Messenger: Address, l2Messenger: Address, messagePasser: Address, portal: Address }),
  z.strictObject({ ...common, protocol: z.literal("arbitrum"), inbox: Address, rollupBridge: Address,
    outboxes: z.array(Address).min(1).max(8), arbSys: Address, retryableTx: Address,
    l2EvmChainId: z.number().int().positive(),
  }),
]).superRefine((source, ctx) => {
  const required = source.protocol === "op-stack"
    ? [[source.chainId, source.l1Bridge], [source.chainId, source.l1Messenger], [source.chainId, source.portal],
      [source.l2ChainId, source.l2Bridge], [source.l2ChainId, source.l2Messenger], [source.l2ChainId, source.messagePasser]]
    : [[source.chainId, source.l1Bridge], [source.chainId, source.inbox], [source.chainId, source.rollupBridge],
      ...source.outboxes.map(address => [source.chainId, address]), [source.l2ChainId, source.l2Bridge]];
  if (source.chainId === source.l2ChainId || source.l1Token === source.l2Token ||
    new Set(source.contracts.map(row => `${row.chainId}:${row.address}`)).size !== source.contracts.length ||
    required.some(([chainId, address]) => !source.contracts.some(row => row.chainId === chainId && row.address === address)) ||
    source.contracts.some(row => row.chainId !== source.chainId && row.chainId !== source.l2ChainId) ||
    source.identityReads.some(row => row.chainId !== source.chainId && row.chainId !== source.l2ChainId)) {
    ctx.addIssue({ code: "custom", message: "Messenger review must bind two distinct chains and the exact complete producer contract census" });
  }
});
export type L2MessengerPendingRead = z.infer<typeof L2MessengerPendingReadSchema>;
const Cursor = z.strictObject({ nextBlock: z.number().int().positive(), anchorHash: Word.nullable(),
  nextNonce: Uint, digest: Sha256Schema,
  // Partial blocks retain the completed predecessor census and an authenticated
  // log prefix; the block is rescanned before the remaining events are admitted.
  resume: z.strictObject({ blockHash: Word, logIndex: z.number().int().nonnegative(), nextNonce: Uint }).nullable(),
});
export const L2MessengerPendingCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(2), sourceDigest: Sha256Schema,
  settlementPins: z.tuple([z.strictObject({ number: z.number().int().nonnegative(), hash: Word }), z.strictObject({ number: z.number().int().nonnegative(), hash: Word })]),
  cursors: z.tuple([Cursor, Cursor]),
  messages: z.array(z.strictObject({ direction: z.enum(["deposit", "withdrawal"]), id: Word,
    nonce: Uint, amount: Uint, from: Address, to: Address, blockNumber: z.number().int().nonnegative(), transactionHash: Word,
    relayHash: Word.nullable(), redeemNextBlock: z.number().int().nonnegative(),
    redeemResume: z.strictObject({ blockHash: Word, logIndex: z.number().int().nonnegative() }).nullable(),
  })).max(256),
});
export type L2MessengerPendingCheckpoint = z.infer<typeof L2MessengerPendingCheckpointSchema>;
export const L2MessengerPendingProofSchema = z.strictObject({ sourceDigest: Sha256Schema, checkpointDigest: Sha256Schema,
  pins: z.array(z.strictObject({ chainId: CanonicalChainIdSchema, anchor: z.number().int().nonnegative(),
    anchorHash: Word, observedAtSec: UnixSecondsSchema, nextNonce: Uint })).length(2),
  depositAmount: Uint, withdrawalAmount: Uint,
});
export type L2MessengerPendingProof = z.infer<typeof L2MessengerPendingProofSchema>;
