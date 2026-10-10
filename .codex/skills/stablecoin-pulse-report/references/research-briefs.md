# Pulse Research Briefs

Research explains the Pharos numbers; it never replaces them. With delegation, dispatch all research in one parallel batch, then one independent fact-checker after the copy exists. Otherwise perform sequential research and skeptical review, disclosing that review was not independent. Discover available capabilities via `docs/process/agent-artifacts.md#harness-configuration`; the session's capabilities win.

## Roles

| Role | Capability | Count |
| --- | --- | --- |
| Web researcher | General agent with web search and page reading | 5 (one per cluster) |
| X scout | Read-only agent with live X search | 5 (one per cluster) |
| Fact-checker | Read-only reviewer, different model family from the author when possible | 1 |
| Layout fixer (optional) | General agent with image input, only for template changes | 0–1 |

**Model choice.** When the user excludes a model family, verify the selected capability's model and fallback behavior in the current session, including search tools. If the exclusion cannot be guaranteed, do not use that capability; disclose the limitation in the handoff. The repository does not pin a model fleet.

## X Search Preflight

1. Run a control query against a busy account over the last 7 days (for example `@circle`). Zero posts means the tool is not working; zero posts on a real query is only meaningful after a passing control.
2. If live X search is not callable, check the current session's available capabilities. Do not load personal tool bridges or change global credentials/configuration as part of this report workflow; use web-only research when the capability is unavailable.
3. Budget: X search bills per post fetched. Ask each scout for 12–18 focused calls with handle and date filters. Record the spend in the handoff.

If X still fails, continue web-only and state it.

## Shared Context Block

Paste into every research dispatch, filling the brackets:

```text
# Goal
Evidence for "Stablecoin Pulse: <Month YYYY>", a 2-page monthly stablecoin report for <partner>. Window <start> → <end> (UTC). Explain WHY things moved (integrations, incentives, venue and chain flows, redemptions, issuer mints, macro, regulation), quantified where possible.

# Inputs
Pharos data brief (supply authority): <abs path>/data/brief.md. Pharos digests for the window: <abs path>/data/digests.md.

# Output contract
Markdown only, no file edits. Per item: **Item**: 1–2 line answer naming the drivers with numbers; evidence bullets `source · UTC date · short verbatim quote or figure · URL`; confidence high/medium/low; [INFERENCE] on anything not directly sourced; "not found" when absent. End with "Other notable items" (≤6, sourced).
Rules: never fabricate posts, quotes, numbers, dates or URLs. Prefer primary sources (issuer/protocol blogs and official accounts, governance forums, filings, regulator releases, explorers). Older events are context, never this month's catalyst. Resolve same-ticker coins by the Pharos id given. Skip builds, tests, and formatters.
```

X scouts additionally get: cite posts as `@handle · UTC date · quote · https://x.com/<handle>/status/<id>`; use sleuth and alert accounts (e.g. @lookonchain, @EmberCN, @OnchainLens, @whale_alert, @spotonchain) and official issuer/protocol accounts; keep to the call budget.

## Clusters

Assign each candidate story to exactly one cluster; give both agents of a cluster the same item list with the Pharos numbers (Δ USD, %, chain split, flagged mints).

1. **Growth movers:** crypto-native and fintech dollars gaining supply (yield loops, lending markets, exchange earn products, incentive campaigns, new chain listings).
2. **Dominant issuers and venues:** USDT and USDC daily swings, chain rotation, new chains and L1 launches, exchange and treasury flows, issuer corporate news.
3. **Tokenized cash, RWAs, commodities, rates:** tokenized funds, savings rates, gold and FX tokens, unit-versus-price splits, the month's central-bank decisions and bill yields.
4. **Depegs, incidents, enforcement:** every material depeg in `depegs.json` (cause, status, recovery), exploits and bridge incidents, oracle misprints, freezes, sanctions.
5. **Launches, institutions, policy, market-wide:** new stablecoins and bank or payment-network rails, major issuer developments, regulation milestones (US, EU, UK, Asia), and other trackers' market-wide stats for corroboration.

Clusters 4 and 5 also run open discovery: ask for anything material in the window that the brief does not list.

## Fact-Checker Prompt

```text
Fact-check a finished 2-page monthly stablecoin report before external sharing. Read-only; do not edit files.
Files: <dir>/content.json (copy), <dir>/data/ (Pharos data and brief), <dir>/research/ (sourced evidence).
For every claim in kpis, tldr, movers rows, section items, watch, annex bodies and source links, flag:
1 numbers/dates/names that do not match evidence (show file and value); 2 causal wording stronger than the evidence (propose exact softer wording); 3 claims with no support; 4 links that do not support their sentence or are absent from research; 5 page-1 vs annex inconsistencies.
Return a table: field path · excerpt · issue type · evidence · exact replacement. End with a verdict: ship / ship after fixes / do not ship.
```
