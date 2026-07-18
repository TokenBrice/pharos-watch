import {
  BLACKLIST_STABLECOINS,
  type BlacklistStablecoin,
  type BlacklistEventType,
} from "@shared/types/market";
import { getTrackedStablecoin } from "@shared/lib/tracked-stablecoin-utils";
import { chainConfig, type ChainConfig } from "./chain-config";
import { resolveRequiredTrackedContractConfig } from "./tracked-contract-resolution";

export { chainConfig, type ChainConfig };

export interface ContractEventConfig {
  configKey: string;
  chain: ChainConfig;
  stablecoinId: string;
  stablecoin: BlacklistStablecoin;
  contractAddress: string;
  decimals: number;        // Token decimals (6 for USDC/USDT/XAUT, 18 for PAXG)
  startBlock?: number;     // Optional deployment/start block for initial sync bootstrapping
  events: BlacklistEventDef[];
}

export interface BlacklistEventDef {
  signature: string;     // Human-readable event signature
  topicHash: string;     // Keccak256 of the event signature
  eventType: BlacklistEventType;
  hasAmount: boolean;
  addressTopicIndex?: number;  // EVM: which topics[] slot holds the affected address (default 1)
  addressDataIndex?: number;   // EVM: which 32-byte data slot holds the affected address
  addressArrayData?: boolean;  // EVM: event data is ABI-encoded address[]; emits one row per address
  amountTopicIndex?: number;   // EVM: which topics[] slot holds an indexed uint256 amount
  amountDataIndex?: number;    // EVM: which 32-byte data slot holds a non-indexed uint256 amount
  tronResultKey?: string;      // Tron: which result key holds the affected address
  /** When set, the uint8/bool at this 32-byte data slot decides whether this
   *  event means 'blacklist' (non-zero) or 'unblacklist' (zero). Overrides
   *  `eventType` for the produced row. */
  eventTypeFromDataBoolIndex?: number;
}

export interface BlacklistEventFamily {
  key: string;
  events: readonly BlacklistEventDef[];
}

interface ContractEventConfigSpec {
  chain: ChainConfig;
  stablecoinId: string;
  stablecoin?: BlacklistStablecoin;
  contractSource?: "primary" | "traded";
  contractAddressOverride?: string;
  decimalsOverride?: number;
  startBlock?: number;
  events: readonly BlacklistEventDef[];
}

const ETHEREUM  = chainConfig("ethereum");
const ARBITRUM  = chainConfig("arbitrum");
const BASE      = chainConfig("base");
const OPTIMISM  = chainConfig("optimism");
const POLYGON   = chainConfig("polygon");
const AVALANCHE = chainConfig("avalanche");
const BSC       = chainConfig("bsc");
const GNOSIS    = chainConfig("gnosis");
const TRON      = chainConfig("tron");

// --- Event topic hashes (Keccak256) ---

// USDC events
const USDC_BLACKLISTED_TOPIC = "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855"; // Blacklisted(address)
const USDC_UNBLACKLISTED_TOPIC = "0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e"; // UnBlacklisted(address)

// USDT events (legacy: Ethereum, Tron, and pre-USDT0 L2 contracts)
const USDT_ADDED_BLACKLIST_TOPIC = "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc"; // AddedBlackList(address)
const USDT_REMOVED_BLACKLIST_TOPIC = "0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c"; // RemovedBlackList(address)
const USDT_DESTROYED_FUNDS_TOPIC = "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6"; // DestroyedBlackFunds(address,uint256)

// USDT0 events (new Tether L2 contract: WithBlockedList + TetherToken, uses indexed address)
const USDT0_BLOCK_PLACED_TOPIC = "0x406bbf2d8d145125adf1198d2cf8a67c66cc4bb0ab01c37dccd4f7c0aae1e7c7"; // BlockPlaced(address indexed)
const USDT0_BLOCK_RELEASED_TOPIC = "0x665918c9e02eb2fd85acca3969cb054fc84c138e60ec4af22ab6ef2fd4c93c27"; // BlockReleased(address indexed)
const USDT0_DESTROYED_FUNDS_TOPIC = "0x6a2859ae7902313752498feb80a014e6e7275fe964c79aa965db815db1c7f1e9"; // DestroyedBlockedFunds(address indexed,uint256)

// --- USDC event definitions ---

function defineEventFamily(key: string, events: readonly BlacklistEventDef[]): BlacklistEventFamily {
  return { key, events };
}

const USDC_EVENT_FAMILY = defineEventFamily("circle-blacklist", [
  {
    signature: "Blacklisted(address)",
    topicHash: USDC_BLACKLISTED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnBlacklisted(address)",
    topicHash: USDC_UNBLACKLISTED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- USDT event definitions ---

const USDT_EVENT_FAMILY = defineEventFamily("tether-legacy-blacklist", [
  {
    signature: "AddedBlackList(address)",
    topicHash: USDT_ADDED_BLACKLIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "RemovedBlackList(address)",
    topicHash: USDT_REMOVED_BLACKLIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "DestroyedBlackFunds(address,uint256)",
    topicHash: USDT_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);

// Avalon USDa exposes the legacy AddedBlackList/RemovedBlackList events, but
// its verified ABI does not expose Tether's DestroyedBlackFunds event.
const AVALON_USDA_EVENT_FAMILY = defineEventFamily("avalon-usda-blacklist", [
  {
    signature: "AddedBlackList(address)",
    topicHash: USDT_ADDED_BLACKLIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "RemovedBlackList(address)",
    topicHash: USDT_REMOVED_BLACKLIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- USDT0 event definitions (Arbitrum and other USDT0-upgraded L2s) ---
// These use indexed address params, so the address is in topics[1] not data.

const USDT0_EVENT_FAMILY = defineEventFamily("tether-indexed-blacklist", [
  {
    signature: "BlockPlaced(address)",
    topicHash: USDT0_BLOCK_PLACED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "BlockReleased(address)",
    topicHash: USDT0_BLOCK_RELEASED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "DestroyedBlockedFunds(address,uint256)",
    topicHash: USDT0_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);

// Combined: listen for both legacy and USDT0 events on chains where
// the old bridged USDT was upgraded in-place to USDT0 (Arbitrum, Polygon)
const USDT_UPGRADED_EVENT_FAMILY = defineEventFamily("tether-upgraded-blacklist", [
  ...USDT_EVENT_FAMILY.events,
  ...USDT0_EVENT_FAMILY.events,
]);

// --- PAXG event definitions ---
// AddressFrozen/AddressUnfrozen/FrozenAddressWiped — address is indexed (in topics[1])

const PAXG_FROZEN_TOPIC = "0x90811a8edd3b3c17eeaefffc17f639cc69145d41a359c9843994dc2538203690"; // AddressFrozen(address)
const PAXG_UNFROZEN_TOPIC = "0xc3776b472ebf54114339eec9e4dc924e7ce307a97f5c1ee72b6d474e6e5e8b7c"; // AddressUnfrozen(address)
const PAXG_WIPED_TOPIC = "0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede"; // FrozenAddressWiped(address)

const PAXG_EVENT_FAMILY = defineEventFamily("paxos-freeze", [
  {
    signature: "AddressFrozen(address)",
    topicHash: PAXG_FROZEN_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AddressUnfrozen(address)",
    topicHash: PAXG_UNFROZEN_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "FrozenAddressWiped(address)",
    topicHash: PAXG_WIPED_TOPIC,
    eventType: "destroy",
    hasAmount: false, // Amount not in event; fetched via balanceOf at blockNumber-1
  },
]);

// --- pyUSD event definitions (Paxos PaxosTokenV2 contract) ---
// FreezeAddress/UnfreezeAddress/FrozenAddressWiped — address is indexed (in topics[1])

const PYUSD_FREEZE_TOPIC = "0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392"; // FreezeAddress(address)
const PYUSD_UNFREEZE_TOPIC = "0x150465b020dfc06a59269da94ed66db9b65a516cf4fdd5f583b0f12752339bbe"; // UnfreezeAddress(address)
const PYUSD_WIPED_TOPIC = PAXG_WIPED_TOPIC; // FrozenAddressWiped(address) — same signature as PAXG

export const PYUSD_EVENT_FAMILY = defineEventFamily("paxos-pyusd-freeze", [
  {
    signature: "FreezeAddress(address)",
    topicHash: PYUSD_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnfreezeAddress(address)",
    topicHash: PYUSD_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "FrozenAddressWiped(address)",
    topicHash: PYUSD_WIPED_TOPIC,
    eventType: "destroy",
    hasAmount: false, // Amount not in event; fetched via balanceOf at blockNumber-1
  },
]);

// --- USD1 event definitions (World Liberty Financial Stablecoin contract) ---
// Freeze(address indexed caller, address indexed account) / Unfreeze — affected address in topics[2]

const USD1_FREEZE_TOPIC = "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528"; // Freeze(address,address)
const USD1_UNFREEZE_TOPIC = "0x4f3ab9ff0cc4f039268532098e01239544b0420171876e36889d01c62c784c79"; // Unfreeze(address,address)
const WLFI_FROZEN_DRAINED_TOPIC = "0x76fa81ac53e82d7102caacc3866ae3ca5684caa4c24d995ff4d76ce8a10fbfef"; // FrozenAccountDrained(address,address,uint256)
const WLFI_FROZEN_REALLOCATED_TOPIC = "0x10aa54b8d21641b161adf6251c11512c46fcf822feaf6f66057c006dc29def4a"; // FrozenFundsReallocated(address,address,address,uint256)

const DUAL_INDEX_FREEZE_EVENT_FAMILY = defineEventFamily("dual-index-freeze", [
  {
    signature: "Freeze(address,address)",
    topicHash: USD1_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "Unfreeze(address,address)",
    topicHash: USD1_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
]);

/** WLFI-specific destroy events that live only on the USD1/U contracts, not on
 * shared dual-index-freeze implementations (FDUSD, EURI). */
const WLFI_FREEZE_DESTROY_EVENTS: readonly BlacklistEventDef[] = [
  {
    signature: "FrozenAccountDrained(address,address,uint256)",
    topicHash: WLFI_FROZEN_DRAINED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressTopicIndex: 2,
    amountDataIndex: 0,
    tronResultKey: "account",
  },
  {
    signature: "FrozenFundsReallocated(address,address,address,uint256)",
    topicHash: WLFI_FROZEN_REALLOCATED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressTopicIndex: 2,
    amountDataIndex: 0,
    tronResultKey: "account",
  },
];

// USD1 (WLFI) is the sole consumer of the full freeze+destroy family. FDUSD,
// EURI, and U reuse only the freeze half (DUAL_INDEX_FREEZE_EVENT_FAMILY)
// because their implementations don't emit FrozenAccountDrained or
// FrozenFundsReallocated.
const USD1_EVENT_FAMILY = defineEventFamily("wlfi-freeze-and-destroy", [
  ...DUAL_INDEX_FREEZE_EVENT_FAMILY.events,
  ...WLFI_FREEZE_DESTROY_EVENTS,
]);

// --- RLUSD event definitions (Ripple StablecoinUpgradeableV2 contract) ---
// AccountPaused/AccountUnpaused — affected address is non-indexed in data

const RLUSD_ACCOUNT_PAUSED_TOPIC = "0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346"; // AccountPaused(address)
const RLUSD_ACCOUNT_UNPAUSED_TOPIC = "0x0c18efbde61ac471ead6960a3f1097735c68ecdb685ae8e2a108c28385399a65"; // AccountUnpaused(address)

const RLUSD_EVENT_FAMILY = defineEventFamily("ripple-account-pause", [
  {
    signature: "AccountPaused(address)",
    topicHash: RLUSD_ACCOUNT_PAUSED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AccountUnpaused(address)",
    topicHash: RLUSD_ACCOUNT_UNPAUSED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- USDTB event definitions (Anchorage / Ethena USDtb contract) ---
// AccountsBlocked/AccountsUnblocked — event data is a dynamic address[].

const USDTB_ACCOUNTS_BLOCKED_TOPIC = "0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87"; // AccountsBlocked(address[])
const USDTB_ACCOUNTS_UNBLOCKED_TOPIC = "0x4a637dd1cd99ae43d353009d0ffbc16b05cc69808b819ebf852c68ea47b34dd4"; // AccountsUnblocked(address[])

const USDTB_EVENT_FAMILY = defineEventFamily("anchorage-batch-block", [
  {
    signature: "AccountsBlocked(address[])",
    topicHash: USDTB_ACCOUNTS_BLOCKED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressArrayData: true,
  },
  {
    signature: "AccountsUnblocked(address[])",
    topicHash: USDTB_ACCOUNTS_UNBLOCKED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressArrayData: true,
  },
]);

// --- A7A5 event definitions (Old Vector RUB-backed token) ---
// Blacklisted/DeBlacklisted addresses are non-indexed in event data.

const A7A5_DEBLACKLISTED_TOPIC = "0x8e6c9e5ceff66044a0b27759779a9be2e7c99655252b235ff3f754efb6b8a616"; // DeBlacklisted(address)

const A7A5_EVENT_FAMILY = defineEventFamily("a7a5-blacklist", [
  {
    signature: "Blacklisted(address)",
    topicHash: USDC_BLACKLISTED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "DeBlacklisted(address)",
    topicHash: A7A5_DEBLACKLISTED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "DestroyedBlackFunds(address,uint256)",
    topicHash: USDT_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);

// --- AccountFrozen/AccountUnfrozen event definitions (Agora AUSD) ---

const ACCOUNT_FROZEN_TOPIC = "0x4f2a367e694e71282f29ab5eaa04c4c0be45ac5bf2ca74fb67068b98bdc2887d"; // AccountFrozen(address)
const ACCOUNT_UNFROZEN_TOPIC = "0xf915cd9fe234de6e8d3afe7bf2388d35b2b6d48e8c629a24602019bde79c213a"; // AccountUnfrozen(address)

const ACCOUNT_FREEZE_EVENT_FAMILY = defineEventFamily("account-freeze", [
  {
    signature: "AccountFrozen(address)",
    topicHash: ACCOUNT_FROZEN_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AccountUnfrozen(address)",
    topicHash: ACCOUNT_UNFROZEN_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- FRXUSD (Frax USD) freeze event definitions ---
// Verified ABI on implementation 0x0000000048d2c8baf31742f6765383278bada4d5
// (behind TransparentUpgradeableProxy 0xcacd6fd266af91b8aed52accc382b4e165586e29)
// emits AccountFrozen(address) / AccountThawed(address) — both with the address
// param as NON-INDEXED (in data[0]). The AccountFrozen topic hash matches the
// Agora AUSD family (same signature, indexed-ness does not affect keccak), but
// the unfreeze event uses AccountThawed instead of AccountUnfrozen, so a
// distinct topic constant is required.

const ACCOUNT_THAWED_TOPIC = "0x74bb8c2778db9c683c274e7bfdcb56dba4f1c737411c8182363097eec281eea4"; // AccountThawed(address)

const FRAX_FREEZE_FAMILY = defineEventFamily("frax-freeze", [
  {
    signature: "AccountFrozen(address)",
    topicHash: ACCOUNT_FROZEN_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressDataIndex: 0,
  },
  {
    signature: "AccountThawed(address)",
    topicHash: ACCOUNT_THAWED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressDataIndex: 0,
  },
]);

// --- OpenEden / tokenized issuer account ban events ---

const ACCOUNT_BANNED_TOPIC = "0xf5ccd95e2294edead25b59a71c189b3543cffbde2ec0d763800bdcc8807c7c3e"; // AccountBanned(address)
const ACCOUNT_UNBANNED_TOPIC = "0xc98af8f4ec4ddc4c9cd83aa9d9adbf34053062dc51ad93a562c787c2cc5dbc47"; // AccountUnbanned(address)

const ACCOUNT_BAN_EVENT_FAMILY = defineEventFamily("account-ban", [
  {
    signature: "AccountBanned(address)",
    topicHash: ACCOUNT_BANNED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AccountUnbanned(address)",
    topicHash: ACCOUNT_UNBANNED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- Hex Trust blacklist events ---

const HEX_TRUST_ADDED_BLACKLIST_TOPIC = "0x86c048150dfc5def3c35f7bc81582956dd964e56d8c028c9f4f5e978bb203c31"; // AddedBlacklist(address)
const HEX_TRUST_REMOVED_BLACKLIST_TOPIC = "0x90792cb7177eb70be35a14e39400d4143370da97f528237fd2b069e408ca68fb"; // RemovedBlacklist(address)

const ADDED_REMOVED_BLACKLIST_EVENT_FAMILY = defineEventFamily("added-removed-blacklist", [
  {
    signature: "AddedBlacklist(address)",
    topicHash: HEX_TRUST_ADDED_BLACKLIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "RemovedBlacklist(address)",
    topicHash: HEX_TRUST_REMOVED_BLACKLIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- Deny-list batch events ---

const ADDED_TO_DENY_LIST_TOPIC = "0x02dd2f2ab1d45714c6f178e8ff8c5594023ec5d134bb99bbb230adabdb718c05"; // AddedToDenyList(address[])
const REMOVED_FROM_DENY_LIST_TOPIC = "0xfe849628f690f8527fe506998b4ddf44a5b11ecb3ec64257db0951b62d9a4f38"; // RemovedFromDenyList(address[])

const DENY_LIST_EVENT_FAMILY = defineEventFamily("deny-list", [
  {
    signature: "AddedToDenyList(address[])",
    topicHash: ADDED_TO_DENY_LIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressArrayData: true,
  },
  {
    signature: "RemovedFromDenyList(address[])",
    topicHash: REMOVED_FROM_DENY_LIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressArrayData: true,
  },
]);

// --- Tokenised GBP ban events ---

const BANNED_TOPIC = "0x30d1df1214d91553408ca5384ce29e10e5866af8423c628be22860e41fb81005"; // Banned(address)
const UNBANNED_TOPIC = "0xb39966eac8a0ae96284afcbb1a1e8eb366677548a09cf1bf773b39b26bedd234"; // UnBanned(address)

const BANNED_EVENT_FAMILY = defineEventFamily("banned-unbanned", [
  {
    signature: "Banned(address)",
    topicHash: BANNED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnBanned(address)",
    topicHash: UNBANNED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- Securitize / BUIDL seize-only events ---

const SECURITIZE_SEIZE_TOPIC = "0x5068c48f7f290ce2b8d555bd28014be9f312999bb621037ea3e9fc86335a21d7"; // Seize(address,address,uint256,string)
const SECURITIZE_OMNIBUS_SEIZE_TOPIC = "0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9"; // OmnibusSeize(address,address,uint256,string,uint8)

const SECURITIZE_SEIZE_EVENT_FAMILY = defineEventFamily("securitize-seize", [
  {
    signature: "Seize(address,address,uint256,string)",
    topicHash: SECURITIZE_SEIZE_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressTopicIndex: 1, // from (victim)
    amountDataIndex: 0,   // value occupies the first 32-byte data slot (reason follows as dynamic tail)
  },
  {
    signature: "OmnibusSeize(address,address,uint256,string,uint8)",
    topicHash: SECURITIZE_OMNIBUS_SEIZE_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressDataIndex: 0,
    amountDataIndex: 1,
  },
]);

// --- Societe Generale Forge (EURCV) event definitions ---
// Verified implementation ABI (0xf4ccc80c4b831a0d8d1414f2aca82a3d760ff05b,
// behind ERC1967Proxy 0x5f7827fdeb7c20b443265fc2f40845b715385ff2) emits batch
// AddressesFrozen(address[]) / AddressesUnFrozen(address[]) events (note the
// capital F in UnFrozen — differs from the plan's assumed AddressesUnfrozen).

const SOCGEN_ADDRESSES_FROZEN_TOPIC = "0x07381cac78ed3e2aa4d96e0d2c80e39d1c2fff09d8f6f079fa7249b553f45425"; // AddressesFrozen(address[])
const SOCGEN_ADDRESSES_UNFROZEN_TOPIC = "0xb474664863a35c00b84f99fe9155ea67676b17495d6f9d6b0277787801f77a45"; // AddressesUnFrozen(address[])

const SOCGEN_FREEZE_FAMILY = defineEventFamily("socgen-freeze", [
  {
    signature: "AddressesFrozen(address[])",
    topicHash: SOCGEN_ADDRESSES_FROZEN_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressArrayData: true,
  },
  {
    signature: "AddressesUnFrozen(address[])",
    topicHash: SOCGEN_ADDRESSES_UNFROZEN_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressArrayData: true,
  },
]);

// --- Neutrl (NUSD) event definitions ---
// Verified ABI on 0xe556aba6fe6036275ec1f87eda296be72c811bce emits separate
// AddedToDenylist(address indexed) / RemovedFromDenylist(address indexed)
// events — no bool discriminator, no amount payload.

const NEUTRL_ADDED_TO_DENYLIST_TOPIC = "0x8d6233ac6005c4f3eaa99b3aebdbe7ad15476dd961858142c4080952392f979d"; // AddedToDenylist(address)
const NEUTRL_REMOVED_FROM_DENYLIST_TOPIC = "0x29e32a16a9d465ee92796d9fc7e93d2a9ab78cdc803298df7ed84b52d19cd42f"; // RemovedFromDenylist(address)

const NEUTRL_DENYLIST_FAMILY = defineEventFamily("neutrl-denylist", [
  {
    signature: "AddedToDenylist(address)",
    topicHash: NEUTRL_ADDED_TO_DENYLIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "RemovedFromDenylist(address)",
    topicHash: NEUTRL_REMOVED_FROM_DENYLIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- Fidelity Digital Dollar (FIDD) event definitions ---
// Verified implementation ABI (0x8ae9cb3d9095da33555494110f567e3d974c6753,
// behind ERC1967Proxy 0x7c135549504245b5eae64fc0e99fa5ebabb8e35d) emits
// TransferRestrictionImposed(address indexed) / TransferRestrictionRemoved(
// address indexed) — not the AccountRestricted / AccountUnrestricted names
// anticipated in the plan. Address is indexed, so default topics[1] applies.

const FIDELITY_RESTRICTED_TOPIC = "0x31180c9d9d89196003f30f7b6643004f76e5feb146dbf10ae71764a88cfed5ef"; // TransferRestrictionImposed(address)
const FIDELITY_UNRESTRICTED_TOPIC = "0x1c425db0931b7efc6b31b2491db198b75f20cfd6885f51c35f5f2a5495ef4619"; // TransferRestrictionRemoved(address)

const FIDELITY_RESTRICTION_FAMILY = defineEventFamily("fidelity-restriction", [
  {
    signature: "TransferRestrictionImposed(address)",
    topicHash: FIDELITY_RESTRICTED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "TransferRestrictionRemoved(address)",
    topicHash: FIDELITY_UNRESTRICTED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- TrueUSD (TUSD) event definitions ---
// Blacklisted(address indexed account, bool isBlacklisted) — single event for
// both directions; the bool at data slot 0 disambiguates add vs remove via the
// eventTypeFromDataBoolIndex hook.
// DestroyedBlackFunds(address indexed _blackListedUser, uint256 _balance) —
// same topic hash as the USDT legacy family (signature matches; indexed-ness
// does not affect keccak); parser extracts the address from topics[1] when
// topics.length > 1.

const TRUEUSD_BLACKLISTED_TOPIC = "0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8"; // Blacklisted(address,bool)

const TRUEUSD_EVENT_FAMILY = defineEventFamily("trueusd-blacklist", [
  {
    signature: "Blacklisted(address,bool)",
    topicHash: TRUEUSD_BLACKLISTED_TOPIC,
    eventType: "blacklist", // fallback — actual direction resolved from bool slot
    hasAmount: false,
    eventTypeFromDataBoolIndex: 0,
  },
  {
    signature: "DestroyedBlackFunds(address,uint256)",
    topicHash: USDT_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);

// --- JPYC (CENTRE-fork) event definitions ---
// FiatTokenV1 implementation (ETH 0xafac17fc3936a29ca2d2787ced3c5d1c52007d2e, behind ERC1967Proxy)
// emits Blocklisted(address indexed) / UnBlocklisted(address indexed) — distinct from USDC's
// Blacklisted/UnBlacklisted (note the 'ock' vs 'ack' spelling difference) so the keccak differs.

const JPYC_BLOCKLISTED_TOPIC = "0x917c251bb231c4b997a420bebe47edad5c20e70715da16c38e9b2e172e44ab92"; // Blocklisted(address)
const JPYC_UNBLOCKLISTED_TOPIC = "0xbc3fe0fc667d12a7a22748747f024a7d971127ffc48f6622675d3e97a2591a51"; // UnBlocklisted(address)

const CENTRE_BLOCKLISTED_FAMILY = defineEventFamily("centre-blocklisted", [
  {
    signature: "Blocklisted(address)",
    topicHash: JPYC_BLOCKLISTED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnBlocklisted(address)",
    topicHash: JPYC_UNBLOCKLISTED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

const BLACKLIST_STABLECOIN_SET = new Set<BlacklistStablecoin>(BLACKLIST_STABLECOINS);

function resolveBlacklistStablecoinSymbol(
  stablecoinId: string,
  override?: BlacklistStablecoin,
): BlacklistStablecoin {
  if (override) return override;
  const symbol = getTrackedStablecoin(stablecoinId)?.symbol;
  if (!symbol || !BLACKLIST_STABLECOIN_SET.has(symbol as BlacklistStablecoin)) {
    throw new Error(`Unsupported blacklist stablecoin symbol for ${stablecoinId}`);
  }
  return symbol as BlacklistStablecoin;
}

function resolveBlacklistContractConfig(
  spec: ContractEventConfigSpec,
): ContractEventConfig {
  const resolvedContract = resolveRequiredTrackedContractConfig(spec.stablecoinId, spec.chain.chainId, {
    source: spec.contractSource,
    addressOverride: spec.contractAddressOverride,
    decimalsOverride: spec.decimalsOverride,
  });

  return {
    configKey: buildBlacklistConfigKey(spec.chain.chainId, resolvedContract.contractAddress),
    chain: spec.chain,
    stablecoinId: spec.stablecoinId,
    stablecoin: resolveBlacklistStablecoinSymbol(spec.stablecoinId, spec.stablecoin),
    contractAddress: resolvedContract.contractAddress,
    decimals: resolvedContract.decimals,
    startBlock: spec.startBlock,
    events: [...spec.events],
  };
}

// --- Contract addresses per chain ---

/**
 * Deferred-chain note (referenced inline as "deferred — see consolidated
 * contract-creation note").
 *
 * Cause: Etherscan v2 free-tier `getcontractcreation` is only available for
 * Ethereum; it 400s on BSC, Avalanche, and Base. Without a verifiable deploy
 * block we can't bootstrap a bounded incremental sync on those chains.
 *
 * Workaround when we do add a deferred chain: use the chain's native explorer
 * (Blockscout / BscScan / Snowtrace / BaseScan) or a public-RPC `eth_getCode`
 * bisect to resolve the deploy block — the XUSD + XAUm BSC entries landed that
 * way in Task 6.4.
 *
 * Follow-up: tracked in GitHub issue TBD.
 */
const CONTRACT_CONFIG_SPECS: ContractEventConfigSpec[] = [
  // USDC
  { chain: ETHEREUM, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "usdc-circle", startBlock: 2_797_221, events: USDC_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "usdc-circle", startBlock: 38_198_364, events: USDC_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "usdc-circle", startBlock: 7_388_829, events: USDC_EVENT_FAMILY.events },

  // USDT (EVM)
  { chain: ETHEREUM, stablecoinId: "usdt-tether", events: USDT_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "usdt-tether", events: USDT_UPGRADED_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "usdt-tether", startBlock: 2_595, events: USDT_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "usdt-tether", contractSource: "traded", startBlock: 133_193_269, events: USDT0_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "usdt-tether", events: USDT_UPGRADED_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "usdt-tether", startBlock: 4_663_628, events: USDT_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "usdt-tether", startBlock: 176_416, events: USDT_EVENT_FAMILY.events },

  // USDT (Tron)
  { chain: TRON, stablecoinId: "usdt-tether", events: USDT_EVENT_FAMILY.events },

  // PAXG (Ethereum only)
  { chain: ETHEREUM, stablecoinId: "paxg-paxos", events: PAXG_EVENT_FAMILY.events },

  // XAUT (Ethereum only — same event pattern as USDT0: BlockPlaced/BlockReleased/DestroyedBlockedFunds)
  { chain: ETHEREUM, stablecoinId: "xaut-tether", events: USDT0_EVENT_FAMILY.events },

  // pyUSD (Ethereum + Arbitrum)
  { chain: ETHEREUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events },

  // USD1 (Ethereum + BSC + Tron)
  { chain: ETHEREUM, stablecoinId: "usd1-world-liberty-financial", startBlock: 21_720_503, events: USD1_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "usd1-world-liberty-financial", startBlock: 46_151_905, events: USD1_EVENT_FAMILY.events },
  { chain: TRON, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events },

  // USDG (Paxos Global Dollar — Ethereum only for first-wave coverage)
  { chain: ETHEREUM, stablecoinId: "usdg-paxos", startBlock: 20_915_336, events: PYUSD_EVENT_FAMILY.events },

  // RLUSD (Ripple USD — Ethereum account pause/unpause; clawback is not event-covered here)
  { chain: ETHEREUM, stablecoinId: "rlusd-ripple", startBlock: 20_492_031, events: RLUSD_EVENT_FAMILY.events },

  // U (United Stables — Ethereum + BSC, same dual-indexed freeze pattern as USD1)
  { chain: ETHEREUM, stablecoinId: "u-united-stables", startBlock: 24_030_193, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "u-united-stables", startBlock: 71_922_111, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },

  // USDtb (Ethena / Anchorage — Ethereum batch block/unblock events)
  { chain: ETHEREUM, stablecoinId: "usdtb-ethena", startBlock: 21_287_284, events: USDTB_EVENT_FAMILY.events },

  // A7A5 (Old Vector — Ethereum only; Tron requires separate result-key verification)
  { chain: ETHEREUM, stablecoinId: "a7a5-old-vector", startBlock: 22_080_045, events: A7A5_EVENT_FAMILY.events },

  // Wave 2A direct EVM coverage
  { chain: ETHEREUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 17_144_262, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 27_850_220, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 336_278_229, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "brz-transfero", stablecoin: "BRZ", startBlock: 17_517_084, events: USDC_EVENT_FAMILY.events },
  { chain: GNOSIS, stablecoinId: "brz-transfero", stablecoin: "BRZ", startBlock: 33_257_603, events: USDC_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "ausd-agora", stablecoin: "AUSD", startBlock: 342_153_906, events: ACCOUNT_FREEZE_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "ausd-agora", stablecoin: "AUSD", startBlock: 35_760_121, events: ACCOUNT_FREEZE_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 20_217_556, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 40_115_386, events: DUAL_INDEX_FREEZE_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "usdq-quantoz", stablecoin: "USDQ", startBlock: 21_179_575, events: USDT0_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "usdq-quantoz", stablecoin: "USDQ", startBlock: 69_326_454, events: USDT0_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "usdo-openeden", stablecoin: "USDO", startBlock: 20_833_910, events: ACCOUNT_BAN_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "usdo-openeden", stablecoin: "USDO", startBlock: 25_154_101, events: ACCOUNT_BAN_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "usdx-hex-trust", stablecoin: "USDX", startBlock: 21_062_695, events: ADDED_REMOVED_BLACKLIST_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "aid-gaib", stablecoin: "AID", startBlock: 23_682_560, events: DENY_LIST_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "aid-gaib", stablecoin: "AID", startBlock: 394_608_077, events: DENY_LIST_EVENT_FAMILY.events },
  // AID on Base: deferred — see consolidated contract-creation note.
  { chain: ETHEREUM, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 23_046_391, events: BANNED_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 69_696_101, events: BANNED_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 74_668_755, events: BANNED_EVENT_FAMILY.events },
  // TGBP on Base + BSC: deferred — see consolidated contract-creation note.

  // USDP (Paxos Pax Dollar — same freeze pattern as PYUSD/USDG)
  { chain: ETHEREUM, stablecoinId: "usdp-paxos", stablecoin: "USDP", startBlock: 6_294_931, events: PYUSD_EVENT_FAMILY.events },

  // EURC re-enabled with mirror-zero suppression
  { chain: ETHEREUM, stablecoinId: "eurc-circle", startBlock: 14_807_227, events: USDC_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "eurc-circle", startBlock: 15_107_859, events: USDC_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "eurc-circle", startBlock: 26_857_185, events: USDC_EVENT_FAMILY.events },

  // TUSD (TrueUSD) — Ethereum proxy implementation emits both Blacklisted(address,bool) and
  // DestroyedBlackFunds(address,uint256). The ETH Blacklisted event indexes the account in
  // topics[1] and carries the direction bool at data slot 0, resolved via
  // eventTypeFromDataBoolIndex. DestroyedBlackFunds reuses USDT_DESTROYED_FUNDS_TOPIC.
  { chain: ETHEREUM, stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: 6_988_184, events: TRUEUSD_EVENT_FAMILY.events },
  // TUSD on BSC + Avalanche: deferred — see consolidated contract-creation note.
  //   BSC proxy 0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9 and Avalanche proxy
  //   0x1c20e891bab6b1727d14da358fae2984ed9b59eb both emit Blacklisted(address,bool)
  //   only (no DestroyedBlackFunds).
  // Polygon TUSD (UChildERC20Proxy at 0x2e1ad108ff1d8c782fcbbb89aad783ac49586756) is a bridged
  // token without Blacklisted / DestroyedBlackFunds events — no blacklist pipeline to cover.
  // Optimism TUSD (L2StandardERC20 at 0xcb59a0a753fdb7491d5f3d794316f1ade197b21e) is a bridged
  // token without Blacklisted / DestroyedBlackFunds events — no blacklist pipeline to cover.

  // NUSD (Neutrl) — Ethereum only. Verified ABI uses separate
  // AddedToDenylist / RemovedFromDenylist events (not the DenyListUpdated
  // bool pattern the plan anticipated), so the direction is driven by topic hash.
  { chain: ETHEREUM, stablecoinId: "nusd-neutrl", stablecoin: "NUSD", startBlock: 23_495_846, events: NEUTRL_DENYLIST_FAMILY.events },

  // EURCV (Societe Generale Forge) — Ethereum only. ERC1967 proxy delegates to
  // 0xf4ccc80c4b831a0d8d1414f2aca82a3d760ff05b which emits batch
  // AddressesFrozen/AddressesUnFrozen events. Reuses the addressArrayData path
  // already used by USDTB / AID / TGBP deny-list batches.
  { chain: ETHEREUM, stablecoinId: "eurcv-societe-generale-forge", stablecoin: "EURCV", startBlock: 18_427_793, events: SOCGEN_FREEZE_FAMILY.events },

  // USDA (Avalon) — Ethereum implementation emits legacy AddedBlackList /
  // RemovedBlackList only. It has a role-gated burn(address,uint256), but no
  // DestroyedBlackFunds event for event-level destroy tracking.
  { chain: ETHEREUM, stablecoinId: "usda-avalon", stablecoin: "USDA", startBlock: 21_108_194, events: AVALON_USDA_EVENT_FAMILY.events },
  // USDA on BSC: deferred — see consolidated contract-creation note.

  // USAT (Tether USAT) — Ethereum proxy (impl 0x8b98bcd9b1f8ae112fb2b58b45c3bc9a75cc4d0e)
  // emits BlockPlaced / BlockReleased / DestroyedBlockedFunds with indexed address,
  // identical to the USDT0 family used by XAUT and USDQ.
  { chain: ETHEREUM, stablecoinId: "usat-tether", stablecoin: "USAT", startBlock: 23_998_151, events: USDT0_EVENT_FAMILY.events },

  // JPYC (JPY Coin — CENTRE fork) — Ethereum + Polygon. Implementation behind ERC1967Proxy
  // emits Blocklisted(address indexed) / UnBlocklisted(address indexed). JPY-pegged; price is
  // resolved via jpyc-jpyc entry in BLACKLIST_PRICE_ASSET_IDS.
  { chain: ETHEREUM, stablecoinId: "jpyc-jpyc", stablecoin: "JPYC", startBlock: 22_622_960, events: CENTRE_BLOCKLISTED_FAMILY.events },
  { chain: POLYGON, stablecoinId: "jpyc-jpyc", stablecoin: "JPYC", startBlock: 72_306_327, events: CENTRE_BLOCKLISTED_FAMILY.events },
  // JPYC on Avalanche: deferred — see consolidated contract-creation note.

  // FRXUSD (Frax USD) — Ethereum only. TransparentUpgradeableProxy delegates to
  // 0x0000000048d2c8baf31742f6765383278bada4d5 which emits AccountFrozen /
  // AccountThawed with non-indexed address params (addressDataIndex: 0).
  { chain: ETHEREUM, stablecoinId: "frxusd-frax", stablecoin: "FRXUSD", startBlock: 21_543_360, events: FRAX_FREEZE_FAMILY.events },

  // FIDD (Fidelity Digital Dollar) — Ethereum only. ERC1967 proxy delegates to
  // 0x8ae9cb3d9095da33555494110f567e3d974c6753 which emits
  // TransferRestrictionImposed / TransferRestrictionRemoved events (plan
  // anticipated AccountRestricted / AccountUnrestricted names).
  { chain: ETHEREUM, stablecoinId: "fidd-fidelity", stablecoin: "FIDD", startBlock: 16_991_820, events: FIDELITY_RESTRICTION_FAMILY.events },

  // BUIDL seize-only coverage (Securitize token family)
  { chain: ETHEREUM, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 19_343_293, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 63_931_579, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 127_565_419, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 270_969_308, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 52_649_153, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 63_877_025, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },

  // XUSD (StraitsX) — Ethereum + BSC, Circle FiatTokenProxy pattern emits
  // Blacklisted/UnBlacklisted (USDC_EVENT_FAMILY). Implementation verified for
  // both chains; BSC deploy block resolved via public RPC eth_getCode bisect
  // (Etherscan v2 free plan does not support BSC getcontractcreation).
  { chain: ETHEREUM, stablecoinId: "xusd-straitsx", stablecoin: "XUSD", startBlock: 19_132_912, events: USDC_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "xusd-straitsx", stablecoin: "XUSD", startBlock: 41_148_046, events: USDC_EVENT_FAMILY.events },

  // XAUm (Matrixdock) — Ethereum + BSC. Implementation emits indexed
  // BlockPlaced(address) / BlockReleased(address) with no DestroyedBlockedFunds,
  // so USDT0_EVENT_FAMILY matches the two observed events (destroy topic is
  // harmless when absent). Symbol override "XAUM" bypasses the case-sensitive
  // symbol lookup (data corpus uses "XAUm"). BSC deploy block resolved via
  // public RPC eth_getCode bisect.
  { chain: ETHEREUM, stablecoinId: "xaum-matrixdock", stablecoin: "XAUM", startBlock: 20_624_233, events: USDT0_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "xaum-matrixdock", stablecoin: "XAUM", startBlock: 41_776_362, events: USDT0_EVENT_FAMILY.events },
];

export const CONTRACT_CONFIGS: ContractEventConfig[] = CONTRACT_CONFIG_SPECS.map(
  resolveBlacklistContractConfig,
);

const CONTRACT_CONFIG_BY_KEY = new Map(CONTRACT_CONFIGS.map((config) => [config.configKey, config]));

function buildBlacklistConfigKey(chainId: string, contractAddress: string): string {
  return `${chainId}-${contractAddress.toLowerCase()}`;
}

export function getBlacklistConfigByKey(configKey: string): ContractEventConfig | undefined {
  return CONTRACT_CONFIG_BY_KEY.get(configKey.toLowerCase());
}

export function getBlacklistConfigByContract(
  chainId: string,
  contractAddress: string,
): ContractEventConfig | undefined {
  return CONTRACT_CONFIG_BY_KEY.get(buildBlacklistConfigKey(chainId, contractAddress));
}

export function getBlacklistConfigsForSymbolAndChain(
  stablecoin: BlacklistStablecoin,
  chainId: string,
): ContractEventConfig[] {
  return CONTRACT_CONFIGS.filter((config) => config.stablecoin === stablecoin && config.chain.chainId === chainId);
}

export function getBlacklistEventByTopic(
  config: Pick<ContractEventConfig, "events">,
  topicHash: string | null | undefined,
): BlacklistEventDef | undefined {
  if (!topicHash) return undefined;
  // All *_TOPIC constants are already lowercase hex; only normalize the caller-supplied value.
  const normalized = topicHash.toLowerCase();
  return config.events.find((event) => event.topicHash === normalized);
}

export function getBlacklistEventBySignature(
  config: Pick<ContractEventConfig, "events">,
  signature: string | null | undefined,
): BlacklistEventDef | undefined {
  if (!signature) return undefined;
  return config.events.find((event) => event.signature === signature || event.signature.split("(")[0] === signature);
}

export function getBlacklistTopicHashes(
  config: Pick<ContractEventConfig, "events">,
): string[] {
  return [...new Set(config.events.map((event) => event.topicHash))];
}
