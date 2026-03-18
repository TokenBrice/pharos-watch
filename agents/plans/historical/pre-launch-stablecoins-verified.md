# Pre-Launch Stablecoins — Verified & Implementation-Ready

**Verified:** March 17, 2026
**Source:** Kimi Claw research, verified by Claude with web research

## Final List (7 coins)

Excluded from original list:
- **USDH** — already launched & tracked by Pharos as `usdh-native-markets`
- **Cloud Dollar (CLDUSD)** — likely fabricated (institution doesn't exist, parked domain, no press)
- **G7 Banks** — too early (no name, no ticker, no timeline)
- **Streamflow USD+** — dropped (already launched, too small)

---

## 1. Western Union USDPT

```ts
usd("usdpt-western-union", "US Dollar Payment Token", "USDPT", "rwa-backed", "centralized", {
  status: "pre-launch",
  announcedDate: "2025-10",
  expectedLaunchDate: "2026-Q2",
  launchPhase: "announced",
  launchPhaseDetail: "Listed as 'Coming soon' on Anchorage Digital reserve page",
  jurisdiction: "US",
  links: [
    { label: "Website", url: "https://www.westernunion.com" },
    { label: "Twitter", url: "https://x.com/WesternUnion" },
  ],
}),
```

**Notes:**
- Issuer: Anchorage Digital Bank (federally regulated OCC issuer); Western Union is the distribution partner
- Blockchain: Solana
- Backing: fiat-backed (1:1 USD redeemable), not RWA
- "WUUSD" does not exist in any source — ticker is USDPT only
- H1 2026 → Q2 2026; window still open but no launch yet as of mid-March 2026

---

## 2. Roughrider Coin

```ts
usd("roughrider-bnd", "Roughrider Coin", "ROUGHRIDER", "rwa-backed", "centralized", {
  status: "pre-launch",
  announcedDate: "2025-10",
  expectedLaunchDate: "2026-09",
  launchPhase: "beta",
  launchPhaseDetail: "Pilot pending ND Industrial Commission approval (Mar 25, 2026 meeting)",
  jurisdiction: "US",
  links: [
    { label: "Website", url: "https://bnd.nd.gov/roughrider/" },
    { label: "Docs", url: "https://bnd.nd.gov/fintech/" },
    { label: "Twitter", url: "https://x.com/BankofND" },
  ],
}),
```

**Notes:**
- Issuer: Bank of North Dakota (only state-owned bank in the US)
- Blockchain: Solana (via Fiserv's FIUSD platform)
- No ticker confirmed — using "ROUGHRIDER" as placeholder
- Backing: 1:1 USD reserves + short-term (93-day) US Treasury notes
- Wholesale only (bank-to-bank, not consumer-facing)
- Second US state stablecoin after Wyoming's FRNT

---

## 3. Fiserv FIUSD

```ts
usd("fiusd-fiserv", "Fiserv USD", "FIUSD", "rwa-backed", "centralized-dependent", {
  status: "pre-launch",
  announcedDate: "2025-06",
  expectedLaunchDate: "2026",
  launchPhase: "beta",
  launchPhaseDetail: "Platform built; end-of-2025 target slipped, no confirmed production launch",
  jurisdiction: "US",
  links: [
    { label: "Website", url: "https://www.fiserv.com" },
    { label: "Twitter", url: "https://x.com/Fiserv" },
  ],
}),
```

**Notes:**
- Issuer: Fiserv, Inc. (NYSE: FI)
- Blockchain: Solana
- Partners: Paxos (issuance), Circle (ecosystem), PayPal (interoperability), Mastercard (payments network)
- Governance: centralized-dependent (Paxos/Circle as infrastructure partners)
- End-of-2025 launch target appears to have slipped; no clear confirmation of production launch

---

## 4. Qivalis Euro Stablecoin

```ts
eur("eur-qivalis", "Qivalis Euro", "QEUR", "rwa-backed", "centralized", {
  status: "pre-launch",
  announcedDate: "2025-09",
  expectedLaunchDate: "2026-Q4",
  launchPhase: "announced",
  launchPhaseDetail: "Seeking Dutch Central Bank EMI license; in talks with crypto exchanges",
  jurisdiction: "NL",
  links: [
    { label: "Website", url: "https://qivalis.eu" },
    { label: "Twitter", url: "https://x.com/qivaliseu" },
  ],
}),
```

**Notes:**
- Issuer: Qivalis B.V. (Amsterdam, registered at Dutch Trade Register #98235680)
- Consortium of 12 European banks: BNP Paribas, CaixaBank, ING, UniCredit, BBVA, Danske Bank, DZ Bank, SEB, KBC, Raiffeisen Bank International, DekaBank, Banca Sella
- Backing: 40% bank deposits, 60% short-term eurozone government bonds
- No ticker announced — "QEUR" is a placeholder
- No blockchain announced yet (multi-chain planned)
- MiCA-compliant

---

## 5. Polaris pUSD

```ts
usd("pusd-polaris", "Polaris USD", "pUSD", "crypto-backed", "decentralized", {
  status: "pre-launch",
  announcedDate: "2026-01",
  expectedLaunchDate: "2026-Q4",
  launchPhase: "testnet",
  launchPhaseDetail: "Private testnet live",
  yieldBearing: true,
  links: [
    { label: "Website", url: "https://polarisfinance.io" },
    { label: "Twitter", url: "https://x.com/polarisfinance_" },
  ],
}),
```

**Notes:**
- Issuer: Polaris Finance (co-founders: TokenBrice + Robert Mullins / 0xLuude)
- Blockchain: Ethereum
- Backing: crypto-backed (pETH collateral via CDP, no off-chain assets)
- Yield-bearing: protocol revenue (borrowing interest, swap fees, conversion gains, DEX fees)
- Immutable core contracts, no admin keys, fully on-chain

---

## 6. Polaris pGOLD

```ts
other("pgold-polaris", "Polaris Gold", "pGOLD", "crypto-backed", "decentralized", "GOLD", {
  status: "pre-launch",
  announcedDate: "2026-01",
  expectedLaunchDate: "2026-Q4",
  launchPhase: "testnet",
  launchPhaseDetail: "Private testnet live (shared infrastructure with pUSD)",
  links: [
    { label: "Website", url: "https://polarisfinance.io" },
    { label: "Twitter", url: "https://x.com/polarisfinance_" },
  ],
}),
```

**Notes:**
- Same Polaris protocol as pUSD, same pETH collateral pool
- Synthetic gold peg — no physical gold backing (unlike XAUT/PAXG)
- Blockchain: Ethereum

---

## 7. KlarnaUSD

```ts
usd("klarnausd-klarna", "KlarnaUSD", "KLARNAUSD", "rwa-backed", "centralized", {
  status: "pre-launch",
  announcedDate: "2025-11",
  expectedLaunchDate: "2026",
  launchPhase: "testnet",
  launchPhaseDetail: "Live on Tempo testnet since Nov 2025",
  jurisdiction: "SE",
  links: [
    { label: "Website", url: "https://www.klarna.com" },
    { label: "Twitter", url: "https://x.com/Klarna" },
  ],
}),
```

**Notes:**
- Issuer: Klarna (publicly traded as KLAR)
- Issued via Bridge (Stripe's stablecoin infrastructure, acquired for ~$1.1B)
- Blockchain: Tempo (L1 by Stripe/Paradigm, $500M raise at $5B valuation)
- Formally announced Nov 25, 2025 via Klarna press release
- First use case: internal cross-border payment cost reduction, then consumer/merchant
- No ticker symbol officially disclosed — "KLARNAUSD" is based on the announced name
- 114M customers, $112B annual GMV

---

## Summary

| # | ID | Name | Symbol | Peg | Backing | Governance | Launch Phase | Expected |
|---|---|---|---|---|---|---|---|---|
| 1 | usdpt-western-union | US Dollar Payment Token | USDPT | USD | rwa-backed | centralized | announced | Q2 2026 |
| 2 | roughrider-bnd | Roughrider Coin | ROUGHRIDER | USD | rwa-backed | centralized | beta | Sep 2026 |
| 3 | fiusd-fiserv | Fiserv USD | FIUSD | USD | rwa-backed | centralized-dependent | beta | 2026 |
| 4 | eur-qivalis | Qivalis Euro | QEUR | EUR | rwa-backed | centralized | announced | Q4 2026 |
| 5 | pusd-polaris | Polaris USD | pUSD | USD | crypto-backed | decentralized | testnet | Q4 2026 |
| 6 | pgold-polaris | Polaris Gold | pGOLD | GOLD | crypto-backed | decentralized | testnet | Q4 2026 |
| 7 | klarnausd-klarna | KlarnaUSD | KLARNAUSD | USD | rwa-backed | centralized | testnet | 2026 |

## Open Questions for User

1. **Placeholder tickers**: Roughrider has no confirmed ticker (using "ROUGHRIDER"), Qivalis has no confirmed ticker (using "QEUR"), KlarnaUSD has no official symbol (using "KLARNAUSD"). Are these placeholders acceptable, or do you prefer different conventions? USER RESPONSE = OK
2. **expectedLaunchDate format**: The spec supports "YYYY-MM" and "YYYY-QN". Some coins use "H1"/"H2" half-year format — should we convert these to quarters (H1 → Q2, H2 → Q4) or add half-year support? USER RESPONSE = CONVERT TO QUARTER, AS PROPOSED
3. **Fiserv FIUSD**: Announced end-of-2025 launch has slipped. Should we list it as "H1 2026" (optimistic) or "2026" (vague)? USER RESPONSE: 2026
