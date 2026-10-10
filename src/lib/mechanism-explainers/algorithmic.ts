import type { ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "algorithmic",
  headline: "Programmatic peg defense, with different collateral models",
  subtitle:
    "Protocol-level supply rules and arbitrage defend the peg; current designs can hold real collateral, unlike historical pure mint/burn systems.",
  lead: [
    "This mechanism family uses programmatic issuance, redemption, or market operations to defend a target value. Collateral is design-specific: FPI holds FRAX reserves and uses AMOs, USDD 2.0 combines collateralized vaults with Peg Stability Modules, and ZSD enforces a reserve-ratio floor against ZEPH collateral. An algorithmic mechanism does not itself mean an unbacked token. The current collateralized variants are described below.",
    "Pharos taxonomy no longer treats `algorithmic` as a tracked backing bucket; that historical backing label remains for off-catalog PSI assets. The walkthrough below covers the historical pure mint/burn variant, exemplified by UST/LUNA, not the reserve mechanics of FPI, USDD 2.0, or ZSD. Pure uncollateralized algorithmic stablecoins are not a live design pattern at scale in 2026.",
  ],
  howItWorks: [
    {
      id: "burn-governance-token",
      title: "Historical pure mint/burn: burn governance token",
      body: "In the UST/LUNA-style variant, a user burns a governance token of value `V`, and the protocol mints `V` worth of stablecoin. There is no segregated 1:1 collateral: the loop relies on the governance-token market float, itself partly determined by the stablecoin's success. The reverse trip exists too: redeem the stablecoin for `V` of newly minted governance token. Pharos now tracks this as mint-authority and mechanism risk rather than a FreezeWatch freeze tier.",
    },
    {
      id: "historical-mint-burn-arbitrage",
      title: "Historical pure mint/burn: arbitrage loop",
      body: "Above $1, arbitrageurs mint at $1 of governance-token value and sell higher; below $1, they buy the stablecoin and redeem for $1 of newly minted governance token. This historical pure mint/burn loop has no segregated collateral buffer, and each defense changes the governance-token float. It is not the same as collateral-backed AMOs, which can deploy existing reserves.",
    },
    {
      id: "stablecoin-minted",
      title: "Historical pure mint/burn: reflexive stress",
      body: "In this uncollateralized variant, peg stability depends on governance-token liquidity, market confidence, and arbitrageur willingness. In a panic the governance token sells off, newly minted governance tokens lose value before arbitrageurs can sell them, and the peg breaks reflexively. That UST-style dilution loop does not describe ZSD, which never mints ZEPH to defend its peg.",
    },
  ],
  riskProfile: [
    {
      headline: "Reflexive collapse / death spiral",
      body: "Terra/UST went from $1 to roughly $0.10 over four days between May 9 and May 13, 2022; LUNA went from above $80 to fractions of a cent across the same window. Roughly $40 billion of combined market value evaporated. The mechanism worked exactly as designed under normal conditions, and exactly as critics had predicted under coordinated stress. UST is retained as a Pharos shadow asset and replays through `/methodology/stability-index-changelog/` so the May 2022 event remains visible in PSI history.",
    },
    {
      headline: "Pure mint/burn arbitrage breakdown",
      body: "In the historical pure mint/burn variant, the peg only holds when arbitrageurs believe newly minted governance tokens can be sold for at least the redemption value. Once that confidence breaks, the under-peg trade does not close. Collateralized variants instead depend on their actual reserves, issuance thresholds, or PSM capacity; FPI's FPIS dilution backstop is distinct from ZSD's reserve-ratio enforcement without new ZEPH issuance.",
    },
    {
      headline: "Recursive use as collateral",
      body: "UST was deeply embedded across DeFi: Anchor's ~$14B deposit base, the Curve 4pool, lending markets, and synthetic asset protocols all carried direct UST exposure. When UST broke, every protocol holding it was simultaneously impaired. Algorithmic designs that allow themselves to be used as collateral multiply the contagion surface, a property the design family shares with no other archetype on Pharos.",
    },
    {
      headline: "Privileged mint authority retained",
      body: "Many coins carrying this archetype retain uncapped or admin-controlled mint authority without an explicit holder-balance freeze surface. That is no longer a FreezeWatch tier; the Mint Authority module carries the supply-control review while FreezeWatch stays focused on freezes, blocks, wipes, pauses, and upstream value blocks.",
    },
  ],
  representativeCoins: [
    {
      coinId: "usdd-tron-dao-reserve",
      note: "TRON DAO Reserve's stablecoin. USDD 2.0 mints against TRX and sTRX vaults with a CDP-style minimum collateral ratio, and operates USDT/USDC Peg Stability Modules on TRON and Ethereum. Reserves also include the Smart Allocator deployment of stablecoin reserves into Aave and JustLend. Structurally a CDP-plus-PSM hybrid today; classified `algorithmic` on Pharos because of the system's depeg history and retained privileged mint authority.",
    },
    {
      coinId: "fpi-frax",
      note: "Frax's CPI-pegged unit-of-account. Backed 100% by FRAX with AMOs deployed for yield; when AMO yield falls below the prevailing CPI rate, the protocol sells newly minted FPIS via a time-weighted AMM (TWAMM) to top up the treasury. Pegged to U.S. CPI rather than a fixed dollar (`pegCurrency: VAR`, `navToken` flag), so peg deviation is measured against CPI growth rather than $1.",
    },
    {
      coinId: "hbd-hive",
      note: "Hive's algorithmic dollar. The protocol allows HBD-to-HIVE conversion at $1 of HIVE per HBD over a 3.5-day median price window; HIVE-to-HBD conversions require posting collateral. A haircut rule halts new HBD production and reduces the redemption value when the HBD-to-HIVE debt ratio exceeds the protocol's threshold (historically around 30%).",
    },
    {
      coinId: "zsd-zephyr-protocol",
      note: "Djed-inspired stablecoin on a Monero-derived private chain, minted against ZEPH base-coin collateral with a minimum 400% reserve ratio enforced before new ZSD can be issued. No ZEPH is ever minted to defend the ZSD peg, which structurally rules out a UST-style death spiral but leaves ZSD exposed to ZEPH price drawdowns reducing the reserve ratio below the mint threshold.",
    },
  ],
  variations: [
    {
      id: "pure-mint-burn",
      title: "Pure mint/burn (uncollateralized)",
      body: "The canonical UST model: burn governance token, mint stablecoin, with no segregated collateral. The cleanest version of the design, and the one with the most decisive failure mode. Not a live design at scale today; UST itself survives only as a Pharos shadow asset for PSI replay.",
    },
    {
      id: "fractional-conversion-based",
      title: "Fractional and conversion-based",
      body: "FRAX v1 paired partial collateral with an algorithmic remainder before migrating to a fully collateralized model. HBD and ZSD mint against a single protocol-native base coin under conversion rules with safety thresholds (HBD's haircut, ZSD's 400% reserve ratio). These designs limit the death-spiral surface by capping issuance rather than relying purely on arbitrage.",
    },
    {
      id: "cdp-psm-hybrids",
      title: "CDP-plus-PSM hybrids retained under the label",
      body: "USDD 2.0 is structurally a CDP with a Peg Stability Module, close to the `cdp` archetype in mechanism, but it is classified `algorithmic` because of its depeg history and privileged mint path. FPI is a 100%-collateralized CPI tracker with seigniorage-token dilution as its algorithmic backstop. The bucket is broader than its name suggests.",
    },
  ],
  whatToWatch: [
    "Active depeg cap on the Safety Score. Algorithmic designs that trade meaningfully below peg are hard-capped at D (≥10% deviation) or F (≥25% deviation).",
    "DEWS supply-velocity signal on `/depeg`. Algorithmic designs frequently trigger this sub-signal first; contraction in circulating supply is the on-chain symptom of the burn-and-redeem loop running against the peg.",
    "Mint Authority review. Most coins under this archetype retain privileged mint authority; sudden mint bursts and admin-key activity are supply-control risk rather than holder-freeze events.",
    "PegScore and the 7-day deviation chart on `/stablecoin/[id]/`. The composite peg score caps lower for chronic deviators, and the chart shows whether a depeg actually closed or just went stale at a discount.",
    "PSI Top Contributors table. Chronic depegs decay through the PSI factor floor (0.25 after roughly 120 days), so a long-running algorithmic depeg is downweighted in the system-wide stability index rather than amplified.",
    "Live Reserve view where available. USDD exposes a 4-hourly collateral mix (TRX, sTRX, Smart Allocator, USDT PSM); FPI exposes its FRAX reserve and FPIS-sale state. Quarterly snapshots are too coarse for this design family.",
  ],
  crossLinks: [
    {
      href: "/methodology/stability-index-changelog/",
      label: "How PSI replays the May 2022 UST event",
    },
    {
      href: "/methodology/#pegscore-dews-methodology",
      label: "How PegScore and DEWS treat algorithmic deviators",
    },
    {
      href: "/learn/case-studies/terra-ust-2022/",
      label: "Case study: TerraUSD's death spiral",
    },
    {
      href: "/learn/case-studies/iron-titan-2021/",
      label: "Case study: IRON Finance, the algorithmic prequel",
    },
    {
      href: "/coverage/",
      label: "Mint Authority coverage and reviewed supply controls",
    },
    {
      href: "/cemetery/",
      label: "/cemetery obituaries, including UST and earlier algorithmic designs",
    },
    {
      href: "/learn/mechanisms/cdp/",
      label: "Sibling explainer: CDPs, the closest live design family",
    },
  ],
  decommissioned: [
    {
      name: "NuBits",
      date: "2018-03",
      obituary:
        "One of the first stablecoins ever created (2014), NuBits held its peg for two years before holders dumped it to chase Bitcoin gains. A pioneering cautionary tale about algorithmic pegs backed by volatile assets.",
      coinId: "usnbt-nubits-2018-03",
    },
    {
      name: "Empty Set Dollar",
      date: "2021-01",
      obituary:
        "Pioneered the \"seigniorage shares\" model in DeFi. When ESD traded below $1, users could buy coupons (burning ESD) for future redemption at a profit. The mechanism worked during expansion but collapsed when confidence evaporated: coupons expired worthless, and ESD fell to $0.01.",
      coinId: "esd-empty-set-dollar-2021-01",
    },
    {
      name: "Dynamic Set Dollar",
      date: "2021-01",
      obituary:
        "A fork of ESD with faster epoch cycles (2 hours vs 8 hours), designed to stabilize more quickly. Instead, the shorter cycles amplified volatility. DSD spiked to $3 during expansion then collapsed to $0.24 in the same month.",
      coinId: "dsd-dynamic-set-dollar-2021-01",
    },
    {
      name: "Basis Cash",
      date: "2021-01",
      obituary:
        "An anonymous fork of the Basis design, BAC lost its peg within weeks of launch. Later revealed to be co-founded by Do Kwon under a pseudonym. He learned nothing before building the even more catastrophic TerraUSD.",
      coinId: "bac-basis-cash-2021-01",
    },
    {
      name: "IRON",
      date: "2021-06",
      obituary:
        "Dubbed crypto's \"first large-scale bank run.\" IRON was partially collateralized (75% USDC, 25% TITAN). When whales dumped TITAN at its peak, a flawed redemption mechanism sent TITAN from $65 to zero in hours, dragging IRON down with it.",
      coinId: "iron-iron-2021-06",
    },
    {
      name: "Neutrino USD",
      date: "2022-04",
      obituary:
        "Waves-chain algorithmic dollar backed by WAVES via a Terra-style mint/burn loop. Lost its peg after a reflexive crash in WAVES price and never recovered; the loop ran in reverse and never closed back.",
      coinId: "usdn-neutrino-usd-2022-04",
    },
    {
      name: "Beanstalk v1",
      date: "2022-04",
      obituary:
        "Credit-based algorithmic stablecoin governed by on-chain seigniorage. Killed by an $182M flash-loan governance attack that passed a malicious proposal in one block and drained the protocol's reserves.",
      coinId: "bean-beanstalk-v1-2022-04",
    },
    {
      name: "TerraUSD",
      date: "2022-05",
      obituary:
        "The canonical algorithmic-stablecoin failure. UST went from $1 to ~$0.10 across May 9-13, 2022; LUNA went from above $80 to fractions of a cent in the same window; ~$40B of combined market value evaporated. The mechanism worked as designed under normal conditions and as critics had predicted under coordinated stress.",
      coinId: "ust-terrausd-2022-05",
    },
    {
      name: "TerraKRW",
      date: "2022-05",
      obituary:
        "Terra's KRW-pegged sibling, swept away in the same death spiral as UST. Inherited every assumption of the LUNA-burn loop and broke at the same moment.",
      coinId: "krt-terrakrw-2022-05",
    },
    {
      name: "DEI",
      date: "2022-05",
      obituary:
        "Deus Finance's fractional algorithmic dollar, partly backed by USDC and partly by the protocol's DEUS governance token. Collapsed alongside UST in May 2022 when the algorithmic portion of backing lost confidence.",
      coinId: "dei-dei-2022-05",
    },
    {
      name: "SpiceUSD",
      date: "2022-09",
      obituary:
        "SpiceTrade's algorithmic dollar. Lost its peg and faded out of trading without a single catastrophic event: a slow attrition under thin liquidity rather than a UST-style breakdown.",
      coinId: "usds-spiceusd-2022-09",
    },
    {
      name: "USN",
      date: "2022-10",
      obituary:
        "Near Protocol's algorithmic dollar. A double-mint bug left the protocol roughly $40M short of its claimed backing; the Near Foundation eventually wound USN down rather than recapitalize.",
      coinId: "usn-usn-2022-10",
    },
    {
      name: "Bean (v2)",
      date: "2024-05",
      obituary:
        "Beanstalk's relaunched credit-based stablecoin. The second planting failed for the same structural reason as the first: protocol-issued credit cannot defend a $1 peg without an exogenous reserve.",
      coinId: "bean-bean-2024-05",
    },
    {
      name: "Pinto",
      date: "2025-10",
      obituary:
        "A direct Beanstalk fork on Base, launched November 2024. Lost its peg in 2025 after the same supply/credit feedback loop drifted negative and refused to close. Same algorithm, same end.",
      coinId: "pinto-pinto-2025-10",
    },
  ],
};
