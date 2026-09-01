import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "commodity-claim",
  headline: "A title claim on specific vaulted metal",
  subtitle:
    "The token is not a dollar claim. It is legal title to identified bars of gold or silver sitting in a named vault, usually redeemable for physical delivery in whole-bar lots.",
  lead: [
    "A commodity-claim token inverts the usual stablecoin question. Its reference price is one troy ounce (or one gram) of metal rather than $1, so a token that tracks its reference perfectly will still move in dollar terms every day. Pharos tracks these assets because the token's own risk question is the same one every stablecoin faces: is there a real, enforceable, verified claim on the stated asset, and can a holder get out?",
    "The design substitutes a vault for a bank. Buyers send funds, the issuer buys metal and allocates specific numbered bars, and the token is minted as title to that allocated metal. Because the reserve asset is a physical object rather than a bank balance, the risk moves from banking rails and reserve composition to four different questions: whether the holder actually owns identified metal or merely has an unsecured contractual claim on the issuer, who runs the vault and what happens if they fail, whether an independent party reconciles the bar list against token supply, and whether physical redemption is genuinely operable or a marketing line with an unreachable minimum.",
  ],
  howItWorks: [
    {
      title: "Buyer funds, issuer buys metal",
      body: "A KYC-verified buyer sends fiat or stablecoins to the issuer, which purchases metal on a wholesale market. Retail holders almost always arrive through a secondary venue instead; as with fiat-cash, only the primary market touches the metal.",
    },
    {
      title: "Metal is allocated in a named vault",
      body: "The issuer takes delivery into a vault operated by a specialist custodian (Brink's, Loomis, an LBMA-accredited Swiss or Singapore facility, a DMCC vault in Dubai) and allocates specific bars, identified by serial number, refiner, and weight, to the token's reserve. 'Allocated' is the load-bearing word: allocated metal is identified property held for the holders' benefit, while unallocated metal is an unsecured claim on the issuer's own inventory.",
    },
    {
      title: "Token minted as title to that metal",
      body: "Tokens are minted against the allocated weight, typically one token per troy ounce of gold or per ounce of silver, sometimes per gram. Holders can redeem for physical delivery under the issuer's terms, or sell into secondary liquidity. The published bar list, refreshed alongside a periodic inventory attestation, is what lets a holder tie a token to specific metal.",
    },
  ],
  riskProfile: [
    {
      headline: "Title that turns out to be a contract",
      body: "The strongest structures give holders identified, segregated, bankruptcy-remote title to specific bars. Weaker ones give a contractual right against the issuer that happens to be sized to a quantity of metal, with no segregation and no priority if the issuer fails. Both are marketed with the same '1:1 backed by physical gold' copy, and the distinction only appears in the terms of service, the trust deed, or their absence.",
    },
    {
      headline: "Vault and custodian concentration",
      body: "Metal cannot be reissued on another chain or moved with a wire. It sits in one or two facilities, in one or two jurisdictions, under one operator, usually with insurance whose terms are not published. Custodian failure, a seizure order in the vault's jurisdiction, or an export restriction is not a liquidity event that arbitrage repairs; the reserve is physically unavailable.",
    },
    {
      headline: "Assurance that never counts the bars",
      body: "An attestation that restates management's own inventory schedule is weaker than an examination in which the assurance provider observes the metal and reconciles a bar list to token supply. Cadence matters as much as method: a bar list published annually cannot evidence today's allocation. Pharos grades the recorded report's method, scope, and cadence rather than the word used to describe it.",
    },
    {
      headline: "Physical redemption that no holder can reach",
      body: "Physical delivery usually requires a whole London Good Delivery bar (several hundred troy ounces of gold, a six-figure position), plus fabrication, insurance, and freight fees, collection at the vault's jurisdiction, and sometimes eligibility limited to a specific class of account. A redemption right that exists on paper but is unreachable for essentially every holder does not function as an exit.",
    },
    {
      headline: "Commodity price is not a depeg",
      body: "These tokens are volatile in dollars by design. A 5% daily move in a gold token is the gold price, not a mechanism failure. The peg question for a commodity claim is the spread between the token and its metal reference; Pharos scores that spread in the peg layer, which is why the backing pillar deliberately has no separate price-basis component.",
    },
  ],
  representativeCoins: [
    {
      coinId: "xaut-tether",
      note: "Tether Gold. One token represents one troy ounce of gold on a specific London Good Delivery bar held in Switzerland; a lookup tool maps a holder's balance to bar serial numbers. Physical redemption requires a full bar and collection in Switzerland.",
    },
    {
      coinId: "paxg-paxos",
      note: "PAX Gold, issued by Paxos Trust under NYDFS oversight. One token represents one fine troy ounce of a London Good Delivery bar in Brink's custody, with monthly third-party reserve reports and a published bar list.",
    },
    {
      coinId: "xaum-matrixdock",
      note: "Matrixdock Gold. One token per troy ounce, allocated in LBMA-accredited vaults, with redemption offered to qualifying accounts. The nearest structural sibling to XAUT and PAXG outside the two incumbents.",
    },
    {
      coinId: "xagm-matrixdock",
      note: "Matrixdock Silver, the same allocated-vault template applied to silver. Silver's much lower value-to-weight ratio makes storage and delivery economics, not title, the dominant practical constraint.",
    },
    {
      coinId: "kau-kinesis",
      note: "Kinesis Gold, denominated per gram rather than per ounce. The finer unit lowers the smallest meaningful position but does not change the whole-bar economics of physical delivery.",
    },
    {
      coinId: "gldt-gold-dao",
      note: "Gold Token from the Gold DAO, issued on the Internet Computer against tokenized Swiss-vaulted gold. A different chain and issuance stack over the same allocated-metal question.",
    },
  ],
  variations: [
    {
      title: "Allocated versus unallocated",
      body: "The sharpest split in the archetype. Allocated structures name specific bars and hold them for the holders' benefit; unallocated structures give a claim on a quantity of metal from the issuer's pool. Pharos treats the difference as a title question, not a disclosure question. The absence of segregation language is itself the finding.",
    },
    {
      title: "Per-ounce, per-gram, and silver",
      body: "Gold tokens are usually denominated per troy ounce (XAUT, PAXG, XAUm) or per gram (KAU, CGO). Silver tokens (XAGm, KAG) share the mechanism but have very different storage economics, because the same dollar of reserve is roughly eighty times the physical volume.",
    },
    {
      title: "ETF wrappers are a different mechanism",
      body: "A token whose reserve is a share of a physically-backed commodity ETF is a fund-share claim on the trust, not title to allocated metal. The holder's counterparty is the fund and its transfer agent, redemption follows the fund's rules, and Pharos classifies those under the tokenized-fund archetypes rather than here.",
    },
    {
      title: "Metal-collateralized dollar tokens",
      body: "A dollar-pegged token that happens to hold gold as collateral is not a commodity claim: its reference price is $1, its peg mechanism is overcollateralization or issuer redemption, and its metal exposure is a reserve-quality fact. Those assets stay in the dollar archetypes with their gold recorded as allocated-commodity reserve.",
    },
  ],
  whatToWatch: [
    "Safety Score Backing breakdown on /stablecoin/[id]/. Commodity claims are graded on title and allocation, custody continuity, assurance and reconciliation, and physical redemption, not on cash-reserve components.",
    "Proof-of-reserves method, scope, and cadence on the detail page. Look for an examination that reconciles a bar list to token supply, and for how recent the latest report is; an annual inventory schedule is weak evidence of today's allocation.",
    "Redemption Backstop route family. Physical delivery shows up as an off-chain issuer route with a large minimum and a settlement delay; check whether the minimum is reachable for a realistic position before treating it as an exit.",
    "Exit route depth on the Safety Score Exit pillar. For most holders the real exit is secondary-market liquidity, not the vault, and commodity tokens trade in thinner books than major dollar stablecoins.",
    "Peg deviation on the detail page. The reference is the metal price, so read deviation as the token-versus-metal spread; dollar volatility in a commodity token is the commodity, not a failure.",
    "Jurisdiction of the vault, not only of the issuer. Custody continuity and any seizure or export risk follow the metal's physical location, which is frequently a different country from the issuing entity.",
  ],
  crossLinks: [
    {
      href: "/methodology/#safety-scores-methodology",
      label: "Safety Score methodology",
    },
    {
      href: "/learn/mechanisms/fiat-cash/",
      label: "Sibling explainer: custodial cash and cash-equivalents",
    },
    {
      href: "/learn/mechanisms/rwa-credit-fund/",
      label: "Sibling explainer: tokenized fund shares",
    },
    {
      href: "/learn/case-studies/pmusd-precious-metals/",
      label: "Case study: pmUSD's in-situ gold collateral",
    },
    {
      href: "/stablecoins/backing/rwa/",
      label: "Real-world-asset-backed directory",
    },
  ],
  visuals: ARCHETYPE_VISUALS["commodity-claim"],
};
