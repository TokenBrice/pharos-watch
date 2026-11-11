import type { ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "protocol-position",
  headline: "A protocol claim on positions, not direct cash ownership",
  subtitle: "Bridge, vault and module liabilities retain local accounting, custody and recovery risk even when the underlying asset is a stablecoin.",
  lead: [
    "Protocol-position tokens rely on assets held through bridge managers, vault receipts or issuance modules. Their holder claim comes from the exact deployed code and current bindings. They are not necessarily borrower CDPs, direct fund shares or fiat cash claims, and not every member is bridged.",
    "The underlying stablecoin's reserve quality remains upstream. The local position still needs its own liability reconciliation, custody continuity, allocation and default procedure. A high-quality parent cannot erase those local risks, and a receipt and its underlying assets must not both be counted as backing.",
  ],
  howItWorks: [
    { id: "deposit-or-module", title: "Deposit or module issuance", body: "A bridge deposit or an enabled protocol module creates a token liability. Identity review binds the holder claim to the exact token, manager, provider and module deployment." },
    { id: "managed-positions", title: "Assets through protocol positions", body: "Managers and vaults hold or deploy assets into underlying positions. A complete inventory must distinguish external assets, receipts, own-token lending, LP exposure and residual modules without counting circular claims as new backing." },
    { id: "operational-withdrawal", title: "Withdraw through the protocol", body: "Holders use the code-defined withdrawal or swap path. Pending withdrawals, liquidity limits, manager continuity and stress recovery remain separate from an internal conversion rate or a nominal parity quote." },
  ],
  riskProfile: [
    { headline: "Circular or residual exposure", body: "Own-token lending and LP claims need a complete assets-and-liabilities valuation before their economic value is established. Unpriced residuals remain charged as bounded conservation and allocation facts, never assumed zero." },
    { headline: "Position custody and control", body: "A known manager address does not prove continuity, independent governance or insolvency priority. Module or bridge upgrades can change the operational claim, and mint authority remains a separate Control question." },
    { headline: "Withdrawal and recovery mismatch", body: "An ERC-4626 conversion, bridge withdrawal interface or open swap module does not establish executable capacity at an arbitrary notional or funded default recovery." },
  ],
  representativeCoins: [
    { coinId: "usdb-blast", note: "Bridge-issued USDB relies on Ethereum DAI positions through its manager/provider path; local liabilities and pending withdrawals must still reconcile." },
    { coinId: "usdu-usdu-finance", note: "USDU uses a mixed module book, including external stablecoin swaps and endogenous lending/LP exposure. It is not a uniformly bridged or fiat-backed liability." },
  ],
  variations: [
    { id: "bridge-position-liabilities", title: "Bridge-position liabilities", body: "A bridged token's liability lives on a different layer from the underlying position. The bridge, position custodian and outstanding withdrawal book each need exact scope." },
    { id: "mixed-module-liabilities", title: "Mixed issuance modules", body: "External swap modules can coexist with lending and LP modules. Tiny external positions do not certify the full book, stablecoin parity or the value of endogenous claims." },
  ],
  whatToWatch: [
    "Exact current manager, vault, bridge and module bindings.",
    "Liability conservation and encumbrance/allocation unknowns remain visible and priced.",
    "Underlying reserve inheritance only prices the reserve group, not local mechanism components.",
    "Operational redemption evidence is not legal default priority or measured exit depth.",
    "Internal pricing and unrestricted mint controls remain independent risks.",
  ],
  crossLinks: [
    { href: "/methodology/#safety-scores-methodology", label: "Safety Scores: underlying backing and local mechanism risk" },
    { href: "/learn/mechanisms/cdp/", label: "Compare borrower-backed CDPs" },
    { href: "/learn/mechanisms/shared-reserve/", label: "Compare shared reserve liabilities" },
  ],
};
