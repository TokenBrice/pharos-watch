import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "multichain-usdc-2023",
  eyebrow: "Bridge failure",
  title: "Multichain USDC: the bridge died, not the dollar",
  subtitle:
    "Bridge-wrapped USDC on Fantom fell to roughly $0.22 in July 2023 while real USDC never moved a basis point: the backing lived on a bridge that one arrested founder controlled outright.",
  lead: [
    "USDC.m was never USDC. It was a Fantom-chain IOU minted by Multichain's cross-chain router: deposit USDC into the bridge's wallet on one chain, receive a wrapped claim token on the other. The claim traded at a dollar only because the market trusted that the locked deposits backing it were safe and redeemable. That trust was the entire mechanism: there was no reserve account, no attestation, no issuer standing behind the wrapped token, just a smart-contract wallet on the far side of a bridge.",
    "On July 6, 2023, roughly $126M to $130M drained out of Multichain's Fantom, Moonriver, and Dogechain bridge contracts in a single burst of abnormal outflows, with nearly $120M of it leaving the Fantom bridge alone. The deposits that backed every wrapped asset on Fantom were simply gone. USDC.m, with nothing left behind it, repriced to what an unbacked claim is worth: it fell to around 22% of face, near $0.22, and Fantom's DeFi total value locked collapsed from roughly $364M to about $69M within days.",
    "Circle froze about $63M of the underlying USDC on Ethereum, the real dollars that had been swept out of the bridge. Holders of the wrapped USDC.m on Fantom got nothing. The post-mortem revealed why no one could intervene sooner: founder Zhaojun had been in Chinese police custody since around May 21, and the supposedly decentralized MPC bridge ran entirely on his personal cloud account. The \"decentralized\" infrastructure was one person, and when that person disappeared the bridge, and every dollar it claimed to hold, went with him.",
  ],
  relatedCoins: [
    {
      coinId: "usdc-circle",
      note: "The native asset that never moved. Real USDC held its dollar peg throughout the Multichain collapse; the depeg was confined to the Fantom wrapper. Circle even used its freeze authority to lock roughly $63M of the underlying USDC swept out of the bridge, the canonical illustration that wrapped-asset risk is bridge risk, not stablecoin risk.",
    },
  ],
  archetype: "fiat-cash",
  outcome: "died",
  eventDateLabel: "July 2023",
  eventWindow: {
    startISO: "2023-07-06",
    endISO: "2023-07-14",
    peakDeviationBps: -7800,
    lowPrice: 0.22,
  },
  cemeteryId: "usdc-m-multichain-usdc-2023-07",
  timeline: [
    {
      dateISO: "2023-05-21",
      headline: "Antecedent: the founder vanishes",
      body: "Multichain CEO Zhaojun was taken into custody by Chinese police and went silent. The global team soon found their operational access to the MPC node servers revoked: those servers ran under Zhaojun's personal cloud account, which no one else could log into. The single point of failure existed weeks before any funds moved.",
      severity: "low",
    },
    {
      dateISO: "2023-06-01",
      headline: "Fantom projects begin fleeing bridged tokens",
      body: "With the bridge degrading and the CEO unreachable for over a month, some Fantom-based DeFi projects started pulling away from Multichain-bridged assets. The warning was visible: a wrapped token is only as safe as the operator who can move its backing, and that operator had gone dark.",
      severity: "med",
    },
    {
      dateISO: "2023-07-06",
      headline: "Roughly $126M to $130M drains from the bridges",
      body: "Locked assets on Multichain's MPC addresses moved to unknown wallets in a burst of abnormal outflows: about $120M from the Fantom bridge, $6.8M from Moonriver, and roughly $666K from Dogechain. On-chain analysts tallied around $62M of USDC, $31M of wBTC, and $13M of wETH among the largest tranches. Multichain told users to suspend the service and revoke approvals.",
      severity: "high",
      href: "https://www.coindesk.com/business/2023/07/06/multichain-bridges-experience-unannounced-outflows-of-over-130m-in-crypto",
    },
    {
      dateISO: "2023-07-06",
      headline: "USDC.m repegs to its real backing: nothing",
      body: "With the Fantom bridge's deposits gone, every wrapped asset on the chain lost the collateral that gave it value. Bridged USDC fell to roughly 22% of face (near $0.22) and Fantom's DeFi TVL collapsed from about $364M toward $69M. The native USDC on Ethereum did not move at all.",
      severity: "high",
    },
    {
      dateISO: "2023-07-07",
      headline: "Circle freezes ~$63M; Multichain confirms the exploit",
      body: "Circle used its blacklist authority to freeze around $63M of the underlying USDC that had been swept out, across a handful of transactions. The Multichain team confirmed an exploit across the Fantom, Moonriver, and Dogechain bridges and said it could not explain how the MPC-held assets had moved.",
      severity: "high",
      href: "https://www.coindesk.com/tech/2023/07/07/multichain-team-confirms-exploit-across-fantom-moonriver-and-dogechain-bridges",
    },
    {
      dateISO: "2023-07-14",
      headline: "Multichain ceases operations; the keys are gone for good",
      body: "Multichain disclosed that Zhaojun had been detained since May and that his confiscated devices held the only keys to the bridge. After his sister, who had briefly regained access and moved funds, was also detained on July 13, the team announced it was shutting down indefinitely and asked its registrar to take the site offline. USDC.m had no path back to par.",
      severity: "high",
      href: "https://www.dlnews.com/articles/defi/multichain-halts-use-of-crypto-bridge-saying-ceo-arrested/",
    },
  ],
  sections: [
    {
      id: "what-happened",
      heading: "What happened",
      paragraphs: [
        "Multichain (formerly Anyswap) was a cross-chain router. To put USDC on Fantom, you locked native USDC in Multichain's wallet on a source chain and the bridge minted a wrapped representation, USDC.m, on Fantom. The wrapper was supposed to be redeemable one-for-one for the locked deposit, and as long as that redemption was credible, USDC.m traded at a dollar and circulated through Fantom DeFi as if it were the real thing.",
        "On July 6, 2023 the locked deposits left. Around $126M to $130M of assets drained from Multichain's Fantom, Moonriver, and Dogechain bridge contracts in a single abnormal burst, with nearly $120M coming off the Fantom bridge: wBTC, wETH, USDT, and roughly $62M of USDC. Security analysts found no smart-contract bug; the signature pointed to a compromise of the bridge's multi-party-computation keys, the credentials that authorized moving the locked funds.",
        "Because USDC.m existed only as a claim on those now-empty wallets, it repriced to what an unbacked claim is worth. It fell to around 22% of face, near $0.22, and dragged Fantom's DeFi TVL from roughly $364M down toward $69M. Circle froze about $63M of the underlying USDC on Ethereum, but that protected the real dollars, not the holders of the wrapper. Multichain shut down within two weeks, and USDC.m never recovered.",
      ],
    },
    {
      id: "wrapped-is-not-native-the-backing-lives-on-the-bridge",
      heading: "Wrapped is not native: the backing lives on the bridge",
      paragraphs: [
        "The crucial fact is that USDC.m and USDC were never the same asset, even though they shared a ticker and a price chart. Native USDC is a fiat-backed token whose dollar reserve sits with Circle. USDC.m was a derivative of that token: a Fantom-chain claim whose backing was a pile of real USDC locked inside a bridge wallet. The wrapper inherited none of Circle's reserve guarantees; it inherited the bridge's custody risk.",
        "That distinction is invisible in calm markets and decisive in a crisis. When the bridge's deposits were swept out, the native USDC on Ethereum stayed fully backed and held its peg without a flicker, while the Fantom claim on those deposits cratered. The token that wore the stablecoin's clothes failed; the dollar underneath it did not. Anyone who read USDC.m's stable price as evidence of USDC's reserve quality was reading the wrong layer.",
        "This is the missing failure mode that a fiat-cash lens alone does not capture. A wrapped or bridged stablecoin carries the issuer's reserve risk plus the bridge's counterparty and infrastructure risk, and in this case the second risk was the one that bit. Pharos treats bridge-wrapped representations as distinct exposures rather than as interchangeable with their native counterparts, which is why USDC.m sits in the cemetery while USDC trades on.",
      ],
    },
    {
      id: "single-point-of-failure-decentralization",
      heading: "Single-point-of-failure decentralization",
      paragraphs: [
        "Multichain marketed itself as decentralized, secured by multi-party computation so that no single party could move the locked funds. The post-mortem showed that was a fiction. The MPC node servers all ran under founder Zhaojun's personal cloud account, and no other team member could log in. The cryptographic ceremony was distributed; the servers running it were not.",
        "So when Zhaojun was detained around May 21, 2023 and his computers, phones, hardware wallets, and seed phrases were confiscated, the bridge lost its only operator. The team could not maintain the infrastructure, could not rotate keys, and could not protect the deposits. Whoever ended up with the confiscated credentials (the outflows have been attributed to an insider rug pull as much as an external hack) held unilateral control over hundreds of millions of dollars of user funds.",
        "The lesson is that decentralization is an operational property, not a marketing claim. A bridge whose continued solvency depends on one person's freedom and one person's cloud login is a custodial service with extra steps, and its wrapped tokens carry exactly that custodial risk. The label said trustless; the architecture said trust one man.",
      ],
    },
    {
      id: "why-native-usdc-was-untouched",
      heading: "Why native USDC was untouched",
      paragraphs: [
        "Through the entire episode, real USDC held its dollar peg. Circle's reserve of cash and short-dated Treasuries was never involved: the assets that disappeared were USDC deposits that holders had voluntarily locked into a third party's bridge. The failure was downstream of Circle entirely, in infrastructure Circle neither built nor controlled.",
        "Circle did intervene, but in the one way it could: it used the USDC contract's freeze function to blacklist about $63M of the stolen underlying USDC on Ethereum, hampering the attacker's cash-out. That action defended the integrity of native USDC and clawed back real dollars for eventual recovery. It did nothing for USDC.m holders on Fantom, who held claims on a wallet that no longer contained their backing.",
        "The clean contrast is the whole point of the case. One asset is a fiat-backed stablecoin with a reserve and a freeze switch; the other was a bridge IOU with neither. They diverged by roughly 78 cents on the same day because they were never the same risk. The price chart, which had shown them in lockstep for months, had been hiding that the entire time.",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "A wrapped stablecoin is not the stablecoin it names. It is a claim on a bridge, and it carries the bridge's custody, key-management, and operator risk on top of whatever the native issuer brings. Track the wrapper as its own exposure: who holds the locked backing, on what infrastructure, and what happens to your claim if that infrastructure goes dark.",
        "\"Decentralized\" is a property you verify, not a label you accept. If a single account, key holder, or individual can move the collateral or take the servers offline, the protocol is custodial regardless of the cryptography wrapped around it. Multichain's MPC was real and its decentralization was not, and the gap between the two is where the money went.",
        "Counterparty failure can depeg a wrapper while the underlying asset is perfectly healthy. The native dollar never moved; the bridge that held it did. When evaluating a depeg, separate the question \"did the backing fail?\" from \"did access to the backing fail?\" For bridged assets, the second is usually the one that kills you.",
      ],
    },
  ],
  watchpoints: [
    "Bridge-wrapped or bridged stablecoins (a ticker suffix like .m, or a \"bridged\" qualifier) whose backing is custodied in a bridge wallet rather than by the native issuer: the wrapper carries the bridge's counterparty risk, not the issuer's reserve guarantees.",
    "\"Decentralized\" bridges where one individual, account, or key holder can unilaterally move locked collateral or take the validating servers offline. Verify the operational control behind the cryptography.",
    "Concentration of operator and key control in a single founder, especially where infrastructure (cloud accounts, MPC nodes, signing devices) is not provably distributed and survivable if that person disappears.",
    "A wrapped token tracking its native counterpart in calm markets: a flat price chart hides the custody divergence that only appears under stress, when the wrapper can fall to its real backing while the native asset holds par.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/fiat-cash/", label: "Mechanism: fiat-cash stablecoins" },
    { href: "/cemetery/", label: "Stablecoin cemetery" },
    { href: "/stablecoin/usdc-circle/", label: "USDC, the dollar that never moved" },
    { href: "/dependency-map/", label: "Stablecoin dependency map" },
  ],
  sources: [
    {
      label: "Chainalysis: Multichain Exploit, possible hack or rug pull (July 2023)",
      href: "https://www.chainalysis.com/blog/multichain-exploit-july-2023/",
    },
    {
      label: "CoinDesk: Multichain Bridges Exploited for Nearly $130M (July 6, 2023)",
      href: "https://www.coindesk.com/business/2023/07/06/multichain-bridges-experience-unannounced-outflows-of-over-130m-in-crypto",
    },
    {
      label: "CoinDesk: Multichain Team Confirms Exploit Across Fantom, Moonriver and Dogechain (July 7, 2023)",
      href: "https://www.coindesk.com/tech/2023/07/07/multichain-team-confirms-exploit-across-fantom-moonriver-and-dogechain-bridges",
    },
    {
      label: "DL News: Multichain ceasing operations after CEO and sister arrested in China",
      href: "https://www.dlnews.com/articles/defi/multichain-halts-use-of-crypto-bridge-saying-ceo-arrested/",
    },
  ],
  takeaways: [
    "A bridge-wrapped stablecoin is a claim on a bridge wallet, not the native dollar; it carries the bridge's custody risk on top of the issuer's reserve risk.",
    "On July 6, 2023, roughly $126M to $130M drained from Multichain's bridges; Fantom-bridged USDC.m fell to ~$0.22 while native USDC never left par.",
    "The \"decentralized\" MPC bridge ran on one founder's personal cloud account; when he was detained, control of hundreds of millions in user funds went with him.",
    "Circle froze ~$63M of the underlying USDC on Ethereum, protecting the native token, but USDC.m holders on Fantom had no recourse.",
  ],
  metaDescription:
    "When Multichain's bridge collapsed in July 2023, Fantom-wrapped USDC.m fell to ~$0.22 while real USDC held par: bridge risk, not stablecoin risk.",
  datePublished: "2026-06-15",
};
