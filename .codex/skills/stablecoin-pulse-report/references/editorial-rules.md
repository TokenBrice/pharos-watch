# Pulse Editorial And Data Rules

## Audience And Shape

The reader is a partner team that wants the month's pulse in two minutes and the proof on page 2. Each page-1 line answers *what moved, why, and so what*. Prefer one specific mechanism with a number ("Aave's Plasma USDe market filled its $550M cap") over three adjectives. `docs/editorial-style.md` governs register: plain, factual, no hype, no hedging stacks.

Page 1 order: KPI strip → TL;DR (the four-sentence month) → movers table (the causes) → launches and announcements → depegs and incidents → market-wide → what to watch (forward-looking tests with a named metric). Page 2: one annex block per page-1 story that needs evidence, each with 1–3 links, plus a short methodology note.

## Data Authority

- **Headline market cap:** the daily `totalMcapUsd` series from `digest-archive.json` (daily entries, latest per UTC day), as computed in `data/market.json`. Current value, 30-day change, month-to-date, peak and drawdown all come from that one series. If the series' coverage visibly changed across the comparison range, say "below its <month> high" rather than quantifying the drawdown.
- **Per-coin and per-chain changes:** `circulating` versus `circulatingPrevMonth` (30 days), from `movers-30d.csv` and `chain-attribution.json`. Peg buckets are already USD for every peg type: never multiply by price. Divide by price only to derive units (ounces, euros).
- **Excluded rows:** numeric ids (outside the curated registry) and absent or zero baselines are listed in `movers-excluded.csv`; never rank them as movers. Chains with no 30-day baseline are "new" or "no baseline", never +100%.
- **Stability index:** quote PSI from `psi.json` daily history (window start → end, band). Digest prose may quote intraday readings; do not mix the two.
- **Pegs:** current price and deviation from `stablecoins.json` / `peg-summary.json`; historical peaks from `depegs.json`. A digest's "widened to N bps" can be a stored peak with no live quote: check whether a live price exists before calling it a new move.
- Pharos is the supply authority. Other trackers (DefiLlama, rwa.xyz, Artemis, issuer dashboards) are corroboration only; never replace a Pharos number with theirs.

## Data Traps

Check every candidate story against these before researching it:

1. **Issuer inventory mints.** A single large mint to an issuer treasury (see `large-mints.json` counterparty; confirm the label on the explorer) inflates supply without demand. Report the supply change, then the ex-mint change.
2. **Price versus units.** Gold, silver, and non-USD fiat tokens move with their reference price. Split the USD delta with `unit-moves.json`; a falling metal can hide rising ounces and vice versa.
3. **Fund AUM scope.** Tokenized funds can report book-entry (non-token) shares in issuer AUM. Pharos tracks on-chain supply; do not reconcile the two by averaging.
4. **Same ticker, different issuer.** Resolve by Pharos id before searching (examples seen: MSUSD Main Street vs msUSD Metronome, USDA from several issuers, reUSD Re vs Resupply, USX dForce vs Solstice, EURR StablR vs Revolut). Research agents routinely conflate them.
5. **Net hides gross.** A small net change can conceal large two-way churn or a chain rotation. Look at the chain split and daily swings before writing "flat".
6. **Sign and baseline.** Percent moves from tiny bases are not headlines; set a floor (for example, current supply of at least $50M) for percentage-ranked mentions.

## Evidence Ladder For Causal Wording

| Evidence | Wording |
| --- | --- |
| Issuer/protocol primary source or on-chain record names the mechanism and size | "driven by", "because", state the number |
| Credible dated source shows a concurrent mechanism without sizing it | "came with", "alongside", "tracks" |
| Plausible mechanism, indirect evidence | "likely", "consistent with" |
| Nothing found | "no source names the buyer/redeemer" |

Analyst posts and aggregators are attributed ("analysts tracked…") and never outrank primary sources. Old announcements are context, never this month's catalyst. A macro coincidence (rate decision, price move) is context unless a source links it to the flow.

## Fact-Check Checklist

Every KPI, row, item, and annex sentence: number matches `data/` or a cited source; date and entity are right (identity collisions resolved); causal verb matches the ladder; page 1 agrees with the annex; each source link supports the sentence it sits under and resolves; no ranked mover is an excluded row; units and price effects are separated where they matter.
