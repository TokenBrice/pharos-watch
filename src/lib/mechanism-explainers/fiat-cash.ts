import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "fiat-cash",
  headline: "Cash and Treasuries, tokenized 1:1",
  subtitle:
    "Centralized issuers custody dollars in bank accounts and short-term Treasuries; tokens are minted and redeemed on demand.",
  lead: [
    "Fiat-cash is the simplest stablecoin design and, by market cap, the dominant one. A regulated or semi-regulated issuer takes a wire of dollars from a customer, parks the dollars in cash deposits, overnight repos, and short-duration U.S. Treasuries, and mints an equivalent amount of token. The token is redeemable back into dollars on demand for qualifying customers. The peg holds because anyone with a primary-market relationship can arbitrage a discount on a secondary venue back into par by redeeming for cash.",
    "In practice this design moves stablecoin risk off the chain and onto the issuer's banking, legal, and reserve-management stack. The tokens are usually freezable. Reserve composition, custodian quality, attestation cadence (the periodic third-party confirmation that reserves match supply), and issuer jurisdiction are the substance of the risk.",
  ],
  howItWorks: [
    {
      title: "User wires USD",
      body: "A KYC-verified customer wires dollars to the issuer's bank account or its Mint partner. Retail users usually access the token through an exchange instead; that secondary access is why the asset feels 'always at $1' even though only the primary market actually redeems.",
    },
    {
      title: "Issuer holds reserves",
      body: "Cash sits in a Tier 1 mix (bank deposits, overnight Treasury repos, short-duration T-Bills) at named custodians (BNY Mellon for USDC, DBS and Standard Chartered for USDG), attested monthly or quarterly by an external auditor.",
    },
    {
      title: "Token minted on-chain",
      body: "The issuer mints token 1:1 onto a target chain (natively on multiple chains, or via canonical or third-party bridges). Primary-market holders redeem for cash through the issuer at T+0 or T+1; secondary-market traders rely on arbitrageurs to push price back to par.",
    },
  ],
  riskProfile: [
    {
      headline: "Banking-rail freeze",
      body: "On 10 March 2023, Silicon Valley Bank was placed into FDIC receivership with roughly $3.3B of USDC reserves stranded inside it. USDC traded as low as about $0.87 over the weekend of 11-12 March 2023 before federal regulators guaranteed all SVB deposits on 12 March and the peg closed back to $1.00 by 13 March. Reserve segregation does not help if the cash is stuck.",
    },
    {
      headline: "Issuer or custodian failure",
      body: "The design collapses if the issuer is insolvent, the custodian fails to segregate assets, or attestations turn out to be misleading. NuBits, USDR, and Tether's earlier commercial-paper-heavy reserve profile are the canonical reminders that the off-chain leg is the actual risk.",
    },
    {
      headline: "Holder-level freezing and seizure",
      body: "Almost every centralized fiat-cash stablecoin can blacklist or burn balances at the issuer's discretion or by court order. Pharos tracks this on /freezewatch; Tether and Circle freeze addresses on most weeks.",
    },
    {
      headline: "Reserve quality drift",
      body: "Two coins with identical '1:1 backed by U.S. Treasuries' copy can carry materially different risk. Tether's reserves are majority short Treasuries but include a long tail of secured loans, gold, and Bitcoin alongside them; USDC sits inside an SEC-registered government money-market fund and holds only Treasuries, overnight Treasury repos, and bank cash.",
    },
  ],
  representativeCoins: [
    {
      coinId: "usdt-tether",
      note: "The largest dollar stablecoin. Reserves are majority short U.S. Treasuries, with smaller buckets of repos, secured loans, precious metals, and Bitcoin; quarterly BDO Italia attestations. USDT0 is a LayerZero-bridged omnichain variant.",
    },
    {
      coinId: "usdc-circle",
      note: "Reserves are fenced inside the Circle Reserve Fund, an SEC-registered government money-market fund managed by BlackRock and custodied at BNY Mellon, with a smaller bank-cash float at G-SIB banks for daily mint and redemption. Monthly attestations; NYDFS plus 50-state MTL regulated.",
    },
    {
      coinId: "usdg-paxos",
      note: "MAS-licensed with reserves at DBS and Standard Chartered. KYC-gated redemption; EU issuance flows through Paxos Issuance Europe under MiCA.",
    },
    {
      coinId: "pyusd-paypal",
      note: "Issued by Paxos Trust under NYDFS oversight. Backing is USD deposits, Treasury repos, and short Treasuries; KPMG attests monthly.",
    },
    {
      coinId: "eurc-circle",
      note: "The same template as USDC, denominated in euros; reserves in euro-area government securities at regulated EEA institutions; MiCA EMI license.",
    },
  ],
  variations: [
    {
      title: "Pure cash and repo",
      body: "The Circle Reserve Fund model: majority short Treasuries, a smaller overnight-repo sleeve, and a thin bank-cash float, all in a regulated money-market wrapper. USDC, EURC, USDG, RLUSD, and FDUSD sit close to this template.",
    },
    {
      title: "Mixed cash with Bitcoin, gold, and loans",
      body: "USDT's reserve mix includes Bitcoin, gold, and secured loans alongside Treasuries. The peg has held, but the Collateral Quality column on the Safety Score reflects heavier-tail exposure than the pure cash-and-repo profile.",
    },
    {
      title: "MiCA-regulated non-USD pegs and yield-passthrough wrappers",
      body: "EURC, EURI, and EURCV are fiat-cash mechanisms wrapped in a different regulatory shell with ECB-rate dynamics. sUSDC, sUSDT, and equivalents are fiat-cash plus a savings vault; the redemption rail is still the issuer's primary market.",
    },
  ],
  whatToWatch: [
    "Proof-of-reserves attestor tier and cadence on /stablecoin/[id]/. Big 4 monthly is the gold standard; niche or quarterly is acceptable but slower to respond.",
    "Freezable status on the detail page and in /freezewatch Status Buckets. For fiat-cash this is almost always Yes; wrappers show Upstream.",
    "Redemption Backstop route family. Fiat-cash tokens show offchain-issuer with banking-rail redemption. Live-direct telemetry is rare; most rows are documented-bound or heuristic.",
    "V9 Backing reserve exposures on the Safety Score report card. Cash and short-duration government assets differ materially from secured loans, Bitcoin, precious metals, or other higher-tail-risk slices.",
    "Jurisdiction badge. NYDFS, MiCA, and MAS licensed coins behave very differently in a stress event than BVI-only or El Salvador issuers.",
    "Mint and burn flow on /flows. A sustained burn surge against zero mints is the on-chain footprint of a primary-market redemption queue.",
  ],
  crossLinks: [
    {
      href: "/methodology/#safety-scores-methodology",
      label: "Safety Score methodology",
    },
    {
      href: "/methodology/#liquidity-methodology",
      label: "Liquidity Score methodology",
    },
    { href: "/freezewatch/", label: "Freezewatch live blacklist tracker" },
    {
      href: "/stablecoins/governance/cefi/",
      label: "Centralized stablecoin directory",
    },
    {
      href: "/learn/mechanisms/tbill/",
      label: "Sibling explainer: tokenized T-Bill funds",
    },
    {
      href: "/learn/case-studies/usdc-svb-2023/",
      label: "Case study: USDC and the Silicon Valley Bank weekend",
    },
    {
      href: "/cemetery/",
      label: "Cemetery: historical fiat-cash failures",
    },
  ],
  visuals: ARCHETYPE_VISUALS["fiat-cash"],
  decommissioned: [
    {
      name: "Binance USD",
      date: "2023-02",
      obituary:
        "The third-largest stablecoin at $23.5B at its peak. The NYDFS ordered issuer Paxos to stop minting, while the SEC signaled intent to sue. Reserves were intact; the regulator simply revoked the issuer's authority. Binance auto-converted remaining balances to FDUSD in December 2023.",
      coinId: "busd-binance-usd-2023-02",
    },
    {
      name: "HUSD",
      date: "2022-10",
      obituary:
        "Huobi-affiliated fiat-cash dollar. After Justin Sun acquired Huobi and replaced it with USDD, HUSD was delisted with no redemption path and traded down to $0.28. The peg held only as long as the custody relationship did.",
      coinId: "husd-husd-2022-10",
    },
    {
      name: "USDK",
      date: "2023-06",
      obituary:
        "Looked clean on paper: regulated U.S. trust company, ERC-20, audited. Its custodian Prime Trust was secretly gambling client funds and collapsed into receivership $82M short of customer fiat. The textbook fiat-cash custodian-failure mode: the on-chain token only ever represented the off-chain claim.",
      coinId: "usdk-usdk-2023-06",
    },
    {
      name: "Euro Tether",
      date: "2024-11",
      obituary:
        "Tether's euro stablecoin, retired by the issuer once MiCA made EU stablecoin issuance untenable. Holders given a one-year redemption window. A regulatory wind-down without a depeg.",
      coinId: "eurt-euro-tether-2024-11",
    },
    {
      name: "EUROe",
      date: "2025-05",
      obituary:
        "One of the first MiCA-compliant euro stablecoins from Membrane Finance: FIN-FSA regulated, KPMG-audited, ring-fenced euro reserves. Never broke $2M in circulation. Acquired by Paxos in January 2025 and wound down two months later to make room for USDG in Europe.",
      coinId: "euroe-euroe-2025-05",
    },
    {
      name: "Tether CNH",
      date: "2026-02",
      obituary:
        "Tether's offshore-yuan experiment, sunset after years of negligible adoption. Tether stopped issuance and put the token on a one-year redemption clock, citing low demand and operational burden. Holders can redeem until February 2027; the decision itself was the death certificate.",
      coinId: "cnht-tether-cnh-2026-02",
    },
    {
      name: "Palm USD",
      date: "2026-01",
      obituary:
        "Shariah-compliant fiat-cash dollar pegged to Gulf currencies, marketed alongside a $2.8B purchase agreement. Actual circulating supply briefly touched $26M before collapsing to $81K. The promised reserves stayed perpetually \"unreleased\"; the demand never appeared.",
      coinId: "pusd-palm-usd-2026-01",
    },
  ],
};
