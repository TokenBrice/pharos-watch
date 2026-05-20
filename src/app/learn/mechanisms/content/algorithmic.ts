import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "algorithmic",
  headline: "Code-defended dollars with thin collateral",
  subtitle:
    "The peg is held by protocol-level mint/burn rules and arbitrage incentives rather than by 1:1 reserves.",
  lead: [
    "An algorithmic stablecoin keeps its peg through a programmatic mint/burn rule and an arbitrage loop, not through 1:1 collateral. In the canonical form (UST/LUNA), a user burns a governance token to mint a dollar's worth of the stablecoin, and the loop is reversible. The whole mechanism rests on confidence in the governance token — which is precisely what evaporates first in a crisis. \"Reflexive\" describes that feedback: the peg holds because the governance token has value, and the governance token has value partly because the peg holds.",
    "Pharos taxonomy no longer treats `algorithmic` as a live backing bucket. The remaining tokens carrying this archetype tag are either historical shadow assets retained for PSI continuity, or current designs that pair algorithmic peg-defense with some real collateral. Pure uncollateralized algorithmic stablecoins are not a live design pattern at scale in 2026.",
  ],
  howItWorks: [
    {
      title: "Burn governance token",
      body: "A user burns a governance token of value `V`, and the protocol mints `V` worth of stablecoin. There is no 1:1 reserve in a custodian — the only \"backing\" is the governance-token market float, itself partly determined by the stablecoin's success. The reverse trip exists too: redeem the stablecoin for `V` of newly minted governance token. Pharos refers to this redeem-by-dilution surface as the `/freezewatch` Dilutable bucket.",
    },
    {
      title: "Mint/burn AMO",
      body: "An AMO (Algorithmic Market Operations module) is an autonomous on-chain agent that issues or retires stablecoin to nudge the price back to peg. Above $1 it lets anyone mint at $1 and sell higher; below $1 it lets anyone buy on market and redeem for $1 of governance token. The arbitrage is supposed to close the gap. There are no reserves to draw down — every defense action expands or contracts the governance-token float.",
    },
    {
      title: "USDX minted",
      body: "Peg stability now depends on governance-token liquidity, market confidence, and arbitrageur willingness. In calm markets the loop closes. In a panic the governance token sells off, the burn-to-mint arbitrage stops being profitable (the freshly minted governance token is worth less than the stablecoin being redeemed), and the peg breaks reflexively. The DEWS supply-velocity signal frequently surfaces this contraction first.",
    },
  ],
  riskProfile: [
    {
      headline: "Reflexive collapse / death spiral",
      body: "Terra/UST went from $1 to roughly $0.10 over four days between May 9 and May 13, 2022; LUNA went from above $80 to fractions of a cent across the same window. Roughly $40 billion of combined market value evaporated. The mechanism worked exactly as designed under normal conditions, and exactly as critics had predicted under coordinated stress. UST is retained as a Pharos shadow asset and replays through `/methodology/stability-index-changelog/` so the May 2022 event remains visible in PSI history.",
    },
    {
      headline: "Mint/burn arbitrage breakdown",
      body: "The peg only holds when arbitrageurs are confident the governance token can be sold for at least the value being minted. Once that confidence breaks, the under-peg trade does not close, and the protocol cannot fix it from inside the loop. Governance-token dilution as a defense — selling extra supply to top up reserves — works until holders refuse to absorb dilution, typically the moment the defense is most needed.",
    },
    {
      headline: "Recursive use as collateral",
      body: "UST was deeply embedded across DeFi: Anchor's ~$14B deposit base, the Curve 4pool, lending markets, and synthetic asset protocols all carried direct UST exposure. When UST broke, every protocol holding it was simultaneously impaired. Algorithmic designs that allow themselves to be used as collateral multiply the contagion surface — a property the design family shares with no other archetype on Pharos.",
    },
    {
      headline: "Privileged mint authority retained",
      body: "Most coins currently tagged `algorithmic` on Pharos sit in the `Dilutable` `/freezewatch` bucket: the issuer or DAO retains uncapped or admin-controlled mint authority without an explicit holder-balance freeze surface. That is the failure mode the bucket exists to catch — quiet expansion that erodes the per-token claim rather than a single visible depeg event.",
    },
  ],
  representativeCoins: [
    {
      coinId: "usdd-tron-dao-reserve",
      note: "TRON DAO Reserve's stablecoin. USDD 2.0 mints against TRX and sTRX vaults with a CDP-style minimum collateral ratio, and operates USDT/USDC Peg Stability Modules on TRON and Ethereum. Reserves also include the Smart Allocator deployment of stablecoin reserves into Aave and JustLend. Classified `algorithmic` on Pharos because the system has historically traded below peg and retains Dilutable mint authority; the mechanism today is closer to a CDP-plus-PSM hybrid.",
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
      title: "Pure mint/burn (uncollateralized)",
      body: "The canonical UST model: burn governance token, mint stablecoin, with no segregated collateral. The cleanest version of the design, and the one with the most decisive failure mode. Not a live design at scale today; UST itself survives only as a Pharos shadow asset for PSI replay.",
    },
    {
      title: "Fractional and conversion-based",
      body: "FRAX v1 paired partial collateral with an algorithmic remainder before migrating to a fully collateralized model. HBD and ZSD mint against a single protocol-native base coin under conversion rules with safety thresholds (HBD's haircut, ZSD's 400% reserve ratio). These designs limit the death-spiral surface by capping issuance rather than relying purely on arbitrage.",
    },
    {
      title: "CDP-plus-PSM hybrids retained under the label",
      body: "USDD 2.0 is structurally a CDP with a Peg Stability Module — close to the `cdp` archetype in mechanism, but classified `algorithmic` because of its depeg history and Dilutable status. FPI is a 100%-collateralized CPI tracker with seigniorage-token dilution as its algorithmic backstop. The bucket is broader than its name suggests.",
    },
  ],
  whatToWatch: [
    "Active depeg cap on the Safety Score. Algorithmic designs that trade meaningfully below peg are hard-capped at D (≥10% deviation) or F (≥25% deviation).",
    "DEWS supply-velocity signal on `/depeg`. Algorithmic designs frequently trigger this sub-signal first; contraction in circulating supply is the on-chain symptom of the burn-and-redeem loop running against the peg.",
    "`/freezewatch` Dilutable bucket. Most coins under this archetype retain uncapped mint authority; sudden mint bursts and admin-key activity surface in the live tracker before they show up as a peg deviation.",
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
      href: "/methodology/#depeg-methodology",
      label: "How PegScore and DEWS treat algorithmic deviators",
    },
    {
      href: "/freezewatch",
      label: "/freezewatch Dilutable bucket and live mint activity",
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
  visuals: ARCHETYPE_VISUALS.algorithmic,
};
