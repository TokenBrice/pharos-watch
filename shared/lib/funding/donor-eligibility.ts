import type { Donation, FundingChain } from "./schema";
import type { ReportCardGrade } from "../../types/report-card-grade";

export interface DonorKeyQualifyingStablecoin {
  /** Uppercase ledger `asset_symbol` the funding-update reconciliation writes for this coin. Display only. */
  readonly symbol: string;
  /** Display ticker. */
  readonly label: string;
  readonly stablecoinId: string;
  /**
   * Reviewed token contract per funding chain (lowercase). A donation counts
   * only when its `(chain, token_address)` matches one of these; the ticker
   * alone never qualifies, because other tokens reuse these symbols.
   */
  readonly contracts: Readonly<Partial<Record<FundingChain, string>>>;
}

/**
 * Reviewed stablecoins whose donations can count toward a supporter key, in
 * display order. New assets require curation review before granting access;
 * arbitrary ledger tokens must not qualify by default.
 *
 * Kept as static literals because the Worker bundles this module. USDC, USDT,
 * DAI, crvUSD and USDGLO keep every catalog contract on the funding chains they
 * counted on before contract keying; the others list only issuer-documented
 * deployments (source URL per entry).
 * `donor-key-qualifying-stablecoins.test.ts` pins these against the catalog.
 */
export const DONOR_KEY_QUALIFYING_STABLECOINS: readonly DonorKeyQualifyingStablecoin[] = [
  {
    symbol: "USDC",
    label: "USDC",
    stablecoinId: "usdc-circle",
    contracts: {
      ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      optimism: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
      arbitrum: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      polygon: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      gnosis: "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83",
    },
  },
  {
    symbol: "USDT",
    label: "USDT",
    stablecoinId: "usdt-tether",
    contracts: {
      ethereum: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      optimism: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
      arbitrum: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
      polygon: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
      gnosis: "0x4ecaba5870353805a9f068101a40e0f32ed605c6",
    },
  },
  {
    symbol: "DAI",
    label: "DAI",
    stablecoinId: "dai-makerdao",
    contracts: {
      ethereum: "0x6b175474e89094c44da98b954eedeac495271d0f",
      base: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
      optimism: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
      arbitrum: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
      polygon: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
      gnosis: "0x44fa8e6f47987339850636f88629646662444217",
    },
  },
  {
    // Sky Protocol Navigator: https://developers.skyeco.com/quick-start/protocol-navigator/ (module USDS; L2_USDS entries)
    symbol: "USDS",
    label: "USDS",
    stablecoinId: "usds-sky",
    contracts: {
      ethereum: "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
      base: "0x820c137fa70c8691f0e44dc420a5e53c168921dc",
      optimism: "0x4f13a96ec5c4cf34e442b46bbd98a0791f20edc3",
      arbitrum: "0x6491c05a82219b8d1479057361ff1654749b876b",
    },
  },
  {
    // https://aave.com/docs/ecosystem/gho (GHO Token Deployments)
    symbol: "GHO",
    label: "GHO",
    stablecoinId: "gho-aave",
    contracts: {
      ethereum: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f",
      base: "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee",
      arbitrum: "0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33",
      gnosis: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73",
    },
  },
  {
    // https://docs.liquity.org/v2-documentation/technical-docs-and-audits (BOLD Token)
    symbol: "BOLD",
    label: "BOLD",
    stablecoinId: "bold-liquity",
    contracts: {
      ethereum: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
      base: "0x03569cc076654f82679c4ba2124d64774781b01d",
      optimism: "0x03569cc076654f82679c4ba2124d64774781b01d",
      arbitrum: "0x03569cc076654f82679c4ba2124d64774781b01d",
    },
  },
  {
    symbol: "CRVUSD",
    label: "crvUSD",
    stablecoinId: "crvusd-curve",
    contracts: {
      ethereum: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
      base: "0x417ac0e078398c154edfadd9ef675d30be60af93",
      optimism: "0xc52d7f23a2e460248db6ee192cb23dd12bddcbf6",
      arbitrum: "0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5",
      polygon: "0xc4ce1d6f5d98d65ee25cf85e9f2e9dcfee6cb5d6",
      gnosis: "0xabef652195f98a91e490f047a5006b71c85f058d",
    },
  },
  {
    // https://docs.ethena.fi/technical-design/key-addresses (Ethereum; "Most L2s" row)
    symbol: "USDE",
    label: "USDe",
    stablecoinId: "usde-ethena",
    contracts: {
      ethereum: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
      base: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
      optimism: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
      arbitrum: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
    },
  },
  {
    // https://docs.frax.com/frxusd/frxusd-contracts
    symbol: "FRXUSD",
    label: "frxUSD",
    stablecoinId: "frxusd-frax",
    contracts: {
      ethereum: "0xcacd6fd266af91b8aed52accc382b4e165586e29",
      base: "0xe5020a6d073a794b6e7f05678707de47986fb0b6",
      optimism: "0x80eede496655fb9047dd39d9f418d5483ed600df",
      arbitrum: "0x80eede496655fb9047dd39d9f418d5483ed600df",
      polygon: "0x80eede496655fb9047dd39d9f418d5483ed600df",
    },
  },
  {
    // https://docs.liquity.org/liquity-v1/documentation/resources (Contract Addresses)
    symbol: "LUSD",
    label: "LUSD",
    stablecoinId: "lusd-liquity",
    contracts: {
      ethereum: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0",
      base: "0x368181499736d0c0cc614dbb145e2ec1ac86b8c6",
      optimism: "0xc40f949f8a4e094d1b49a23ea9241d289b7b2819",
      arbitrum: "0x93b346b6bc2548da6a1e7d98e9a421b42541425b",
    },
  },
  {
    // https://docs.paxos.com/guides/stablecoin/pyusd/mainnet
    symbol: "PYUSD",
    label: "PYUSD",
    stablecoinId: "pyusd-paypal",
    contracts: {
      ethereum: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
      arbitrum: "0x46850ad61c2b7d64d08c9c754f45254596696984",
      polygon: "0x99af3eea856556646c98c8b9b2548fe815240750",
    },
  },
  {
    // https://docs.ripple.com/products/stablecoin/overview/token-addresses
    symbol: "RLUSD",
    label: "RLUSD",
    stablecoinId: "rlusd-ripple",
    contracts: {
      ethereum: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
      base: "0x8d58c0c60b8d6b88fa98b291a646db34d0f98258",
      optimism: "0x8d58c0c60b8d6b88fa98b291a646db34d0f98258",
    },
  },
  {
    // Paxos Pax Dollar, not Parallel USDp or Unit Protocol USDP: https://docs.paxos.com/guides/stablecoin/usdp/mainnet
    symbol: "USDP",
    label: "USDP",
    stablecoinId: "usdp-paxos",
    contracts: {
      ethereum: "0x8e870d67f660d95d5be530380d0ec0bd388289e1",
    },
  },
  {
    // https://docs.paxos.com/guides/stablecoin/usdg/mainnet
    symbol: "USDG",
    label: "USDG",
    stablecoinId: "usdg-paxos",
    contracts: {
      ethereum: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
      arbitrum: "0x004b506865409877c9fa29bfb1eba929984b9bbc",
    },
  },
  {
    // https://docs.agora.finance/developer/contract-deployments
    symbol: "AUSD",
    label: "AUSD",
    stablecoinId: "ausd-agora",
    contracts: {
      ethereum: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
      base: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
      arbitrum: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
      polygon: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    },
  },
  {
    // https://www.gemini.com/dollar (contract link)
    symbol: "GUSD",
    label: "GUSD",
    stablecoinId: "gusd-gemini",
    contracts: {
      ethereum: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd",
    },
  },
  {
    // https://www.fidelitydigitalassets.com/stablecoin-developer-resources
    symbol: "FIDD",
    label: "FIDD",
    stablecoinId: "fidd-fidelity",
    contracts: {
      ethereum: "0x7c135549504245b5eae64fc0e99fa5ebabb8e35d",
    },
  },
  {
    // SG-FORGE USDCV white paper v2.0: https://www.sgforge.com/wp-content/uploads/2025/08/SG-Forge-USDCV-White-Paper_V2.0_Ethereum_Solana_11082025.pdf
    symbol: "USDCV",
    label: "USDCV",
    stablecoinId: "usdcv-societe-generale-forge",
    contracts: {
      ethereum: "0x5422374b27757da72d5265cc745ea906e0446634",
    },
  },
  {
    // https://www.universal.ae/
    symbol: "USDU",
    label: "USDU",
    stablecoinId: "usdu-universal",
    contracts: {
      ethereum: "0xe4ca6596d2c28014c6f89964f57838e0be9f369b",
    },
  },
  {
    // https://www.straitsx.com/xusd
    symbol: "XUSD",
    label: "XUSD",
    stablecoinId: "xusd-straitsx",
    contracts: {
      ethereum: "0xc08e7e23c235073c6807c2efe7021304cb7c2815",
    },
  },
  {
    // https://docs.reservoir.xyz/security-and-compliance/smart-contract-addresses (core and OFT sections)
    symbol: "RUSD",
    label: "rUSD",
    stablecoinId: "rusd-reservoir",
    contracts: {
      ethereum: "0x09d4214c03d01f49544c0448dbe3a27f768f2b34",
      base: "0x09d4214c03d01f49544c0448dbe3a27f768f2b34",
      arbitrum: "0x09d4214c03d01f49544c0448dbe3a27f768f2b34",
    },
  },
  {
    // https://docs.usd.ai/technical-overview/contract-addresses (Arbitrum hub; issuer OFTs)
    symbol: "USDAI",
    label: "USDai",
    stablecoinId: "usdai-usd-ai",
    contracts: {
      ethereum: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
      base: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
      arbitrum: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
    },
  },
  {
    // https://fxprotocol.gitbook.io/fx-docs/more/resources/contracts; Base OFT: https://github.com/aladdindao/deployments/blob/main/deployments.mainnet.md
    symbol: "FXUSD",
    label: "fxUSD",
    stablecoinId: "fxusd-f-x-protocol",
    contracts: {
      ethereum: "0x085780639cc2cacd35e474e71f4d000e2405d8f6",
      base: "0x55380fe7a1910dff29a47b622057ab4139da42c5",
    },
  },
  {
    // https://docs.asymmetry.finance/developers/contracts (current token, not the legacy one)
    symbol: "USDAF",
    label: "USDaf",
    stablecoinId: "usdaf-asymmetry",
    contracts: {
      ethereum: "0x9cf12ccd6020b6888e4d4c4e4c7aca33c1eb91f8",
    },
  },
  {
    // https://github.com/Tangent-labs/tangent-contracts/blob/main/addresses-prod.json (tokens.USG)
    symbol: "USG",
    label: "USG",
    stablecoinId: "usg-tangent",
    contracts: {
      ethereum: "0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1",
    },
  },
  {
    // https://docs.originprotocol.com/registry/contracts/ousd-registry; rebasing, so one unit stays one dollar
    symbol: "OUSD",
    label: "OUSD",
    stablecoinId: "ousd-origin-protocol",
    contracts: {
      ethereum: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86",
    },
  },
  {
    // https://docs.polymarket.com/resources/contracts (pUSD CollateralToken)
    symbol: "PUSD",
    label: "pUSD",
    stablecoinId: "pusd-polymarket",
    contracts: {
      polygon: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
    },
  },
  {
    // Issuer-listed Arbitrum deployment, not the Ethereum eDOC bridge token: https://moneyonchain.com/doc-stablecoin/
    symbol: "DOC",
    label: "DOC",
    stablecoinId: "doc-money-on-chain",
    contracts: {
      arbitrum: "0x2ad62eb9744c720364f6ac856360a43e8a2229b5",
    },
  },
  {
    // Wrapped xDAI only; native xDAI transfers carry no token contract and never count: https://docs.gnosischain.com/developers/Usefulcontracts
    symbol: "WXDAI",
    label: "WXDAI",
    stablecoinId: "xdai-gnosis",
    contracts: {
      gnosis: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
    },
  },
  {
    // https://developers.circle.com/stablecoins/eurc-contract-addresses; valued at the receipt-date ECB EUR/USD rate.
    symbol: "EURC",
    label: "EURC",
    stablecoinId: "eurc-circle",
    contracts: {
      ethereum: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c",
      base: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
    },
  },
  {
    // https://frankencoin.com/token/; valued at the receipt-date ECB CHF rate.
    symbol: "ZCHF",
    label: "ZCHF",
    stablecoinId: "zchf-frankencoin",
    contracts: {
      ethereum: "0xb58e61c3098d85632df34eecfb899a1ed80921cb",
      base: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
      optimism: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
      arbitrum: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
      polygon: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
      gnosis: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
    },
  },
  {
    // https://www.sgforge.com/stablecoin-elevation/; valued at the receipt-date ECB EUR/USD rate.
    symbol: "EURCV",
    label: "EURCV",
    stablecoinId: "eurcv-societe-generale-forge",
    contracts: {
      ethereum: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2",
    },
  },
  {
    // https://schuman.io/smart-contracts; valued at the receipt-date ECB EUR/USD rate.
    symbol: "EUROP",
    label: "EUROP",
    stablecoinId: "europ-schuman",
    contracts: {
      ethereum: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
      polygon: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
    },
  },
  {
    // https://www.straitsx.com/xsgd; valued at the receipt-date ECB SGD rate.
    symbol: "XSGD",
    label: "XSGD",
    stablecoinId: "xsgd-straitsx",
    contracts: {
      ethereum: "0x70e8de73ce538da2beed35d14187f6959a8eca96",
      base: "0x0a4c9cb2778ab3302996a34befcf9a8bc288c33b",
      arbitrum: "0xe333e7754a2dc1e020a162ecab019254b9dab653",
      polygon: "0xdc3326e71d45186f113a2f448984ca0e8d201995",
    },
  },
  {
    // https://tetradg.com/supported-blockchains/; valued at the receipt-date ECB CAD rate.
    symbol: "CADD",
    label: "CADD",
    stablecoinId: "cadd-cad-digital",
    contracts: {
      ethereum: "0x16f93ebc5320c89efc8701577efe49d14a276a06",
      base: "0x16f93ebc5320c89efc8701577efe49d14a276a06",
    },
  },
  {
    // https://www.macropod.com/transparency/; valued at the receipt-date ECB AUD rate.
    symbol: "AUDM",
    label: "AUDM",
    stablecoinId: "audm-macropod",
    contracts: {
      ethereum: "0x081599e4936d12c46bd48913b2329115cd26cbdd",
      base: "0xeded6ae915b129b67a4ad49901518f2736427063",
    },
  },
  {
    // https://www.blox.my/myrc; valued at the receipt-date ECB MYR rate.
    symbol: "MYRC",
    label: "MYRC",
    stablecoinId: "myrc-blox",
    contracts: {
      ethereum: "0xbed7d999f1d71ac70c263f64c7c7e009d691be2e",
      base: "0x3ed03e95dd894235090b3d4a49e0c3239edce59e",
      arbitrum: "0x3ed03e95dd894235090b3d4a49e0c3239edce59e",
    },
  },
  {
    symbol: "USDGLO",
    label: "USDGLO",
    stablecoinId: "usdglo-glo",
    contracts: {
      ethereum: "0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
      base: "0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
      optimism: "0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
      arbitrum: "0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
      polygon: "0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
    },
  },
];

const QUALIFYING_STABLECOIN_BY_CONTRACT: ReadonlyMap<string, DonorKeyQualifyingStablecoin> = new Map(
  DONOR_KEY_QUALIFYING_STABLECOINS.flatMap((coin) =>
    Object.entries(coin.contracts).map(([chain, address]) => [`${chain}:${address}`, coin] as const),
  ),
);

/**
 * The reviewed stablecoin for a transfer's token contract on a funding chain,
 * or null for native assets (`tokenAddress` null) and unreviewed contracts.
 * The address match ignores case.
 */
export function resolveDonorKeyQualifyingStablecoin(
  chain: FundingChain,
  tokenAddress: string | null,
): DonorKeyQualifyingStablecoin | null {
  if (tokenAddress == null) return null;
  return QUALIFYING_STABLECOIN_BY_CONTRACT.get(`${chain}:${tokenAddress.toLowerCase()}`) ?? null;
}

/**
 * Whether a grade lets a qualifying stablecoin count: A and B bands (with +/−)
 * count, any other published grade (including `NR`) sits outside the band, and
 * an absent grade is unavailable. Unavailable is not "does not count" in copy,
 * but claims still fail closed on it.
 */
export type DonorKeyGradeStatus = "counts" | "outside-band" | "unavailable";

export function donorKeyGradeStatus(grade: ReportCardGrade | null | undefined): DonorKeyGradeStatus {
  if (grade == null) return "unavailable";
  return /^[AB][+-]?$/.test(grade) ? "counts" : "outside-band";
}

export type DonorKeyDonationStatus =
  /** Qualifying stablecoin graded A or B in the supplied grades. */
  | "counted"
  /** Payout-contract row (for example Giveth): the sender can never sign a claim. */
  | "pool"
  /** Asset outside the reviewed stablecoin list (ETH, other tokens). */
  | "not-qualifying"
  /** Qualifying stablecoin graded outside the A/B band (including NR). */
  | "grade-outside-band"
  /** Qualifying stablecoin with no grade in the supplied source. */
  | "grade-unavailable";

export interface DonorKeyDonationClassification {
  readonly status: DonorKeyDonationStatus;
  readonly stablecoin: DonorKeyQualifyingStablecoin | null;
  readonly grade: ReportCardGrade | null;
}

export function classifyDonorKeyDonation(
  row: Donation,
  gradesById: ReadonlyMap<string, ReportCardGrade>,
): DonorKeyDonationClassification {
  const stablecoin = resolveDonorKeyQualifyingStablecoin(row.chain, row.token_address);
  if (row.kind === "pool") return { status: "pool", stablecoin, grade: null };
  if (!stablecoin) return { status: "not-qualifying", stablecoin: null, grade: null };
  const grade = gradesById.get(stablecoin.stablecoinId) ?? null;
  const gradeStatus = donorKeyGradeStatus(grade);
  const status: DonorKeyDonationStatus = gradeStatus === "counts"
    ? "counted"
    : gradeStatus === "outside-band"
      ? "grade-outside-band"
      : "grade-unavailable";
  return { status, stablecoin, grade };
}

/**
 * Sums receipt-date USD for stablecoins graded in the A/B bands at claim time, excluding
 * `pool` rows: pool senders are payout contracts (for example Giveth) and can
 * never sign a claim. Founder rows count so the owner can test the live flow.
 */
export function sumEligibleDonationsByAddress(
  donations: readonly Donation[],
  gradesById: ReadonlyMap<string, ReportCardGrade>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of donations) {
    if (classifyDonorKeyDonation(row, gradesById).status !== "counted") continue;
    const address = row.from_address.toLowerCase();
    totals.set(address, (totals.get(address) ?? 0) + row.usd_at_receipt);
  }
  return totals;
}

export interface DonorKeyEligibilitySummary {
  /** Receipt-date USD of this address's counted donations. */
  readonly qualifyingUsd: number;
  /** Labels of the stablecoins that counted, in `DONOR_KEY_QUALIFYING_STABLECOINS` order. */
  readonly countedAssets: readonly string[];
  /** Every ledger row sent by this address, in ledger order, with its classification. */
  readonly rows: readonly (DonorKeyDonationClassification & { readonly donation: Donation })[];
}

/** Per-address breakdown behind the eligibility total; the address match ignores case. */
export function summarizeDonorKeyEligibility(
  address: string,
  donations: readonly Donation[],
  gradesById: ReadonlyMap<string, ReportCardGrade>,
): DonorKeyEligibilitySummary {
  const target = address.toLowerCase();
  let qualifyingUsd = 0;
  const counted = new Set<string>();
  const rows: (DonorKeyDonationClassification & { donation: Donation })[] = [];
  for (const donation of donations) {
    if (donation.from_address.toLowerCase() !== target) continue;
    const classification = classifyDonorKeyDonation(donation, gradesById);
    rows.push({ ...classification, donation });
    if (classification.status === "counted" && classification.stablecoin) {
      qualifyingUsd += donation.usd_at_receipt;
      counted.add(classification.stablecoin.symbol);
    }
  }
  const countedAssets = DONOR_KEY_QUALIFYING_STABLECOINS
    .filter((coin) => counted.has(coin.symbol))
    .map((coin) => coin.label);
  return { qualifyingUsd, countedAssets, rows };
}

export function isEligibleDonor(
  address: string,
  totals: ReadonlyMap<string, number>,
  thresholdUsd: number,
): boolean {
  const total = totals.get(address.toLowerCase()) ?? 0;
  // The threshold is inclusive, so the epsilon absorbs floating-point drift that
  // would otherwise leave a sum meant to be exactly the threshold just under it.
  return total >= thresholdUsd - 1e-9;
}
