---
name: dependency-coverage-drain
description: Drain Dependency Map coverage-audit queues into reviewed edges, target dispositions, or deferrals. Use monthly, after a coverage drop, or on a weekly audit alert. Not for single-coin reserve research.
---

Read `docs/editorial-style.md` before writing; its `technical-evidence` register governs prose.

# Dependency Coverage Drain

Turn the production audit queues into reviewed dependency changes. Queue items are research leads: the [curation rule and reviewed-ledger contract](../../../docs/runbooks/dependency-network.md#monthly-drain-and-reviewed-ledger) decide what may become an edge, and the weekly production audit alerts but never gates a release.

## Required Context

Read routed docs and scoped instructions, [coverage semantics](../../../docs/dependency-map.md#dependency-coverage-audit), and the runbook's [commands](../../../docs/runbooks/dependency-network.md#scope-and-commands). In `docs/runbooks/artifacts/dependency-coverage-reviewed-ledger.json`, read only the current claim groups and their decision history to derive the latest status; do not preload the whole ledger. Queue builders, thresholds and report sections live in `scripts/lib/dependency-coverage-audit.ts` (`scripts/maintenance/generate-dependency-coverage-audit.ts` is only the CLI wrapper); admission rules in `shared/lib/dependency-derivation.ts`; reviews in `shared/data/coverage-dispositions/dependency-target-dispositions.ts`.

Use the [reserve-research](../reserve-research/SKILL.md) skill for reserve evidence, provenance, custody, backing dependencies and source freshness. Read the relevant adapter and authored reserves before changing a claim. For pinned RPC reads, follow [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence).

## Queue Snapshot

Capture one production JSON, render it, and reconcile that same file, exactly as the runbook's command block shows:

```bash
npm run audit:coverage -- --domain=dependency-coverage --prod --json --report .tmp/dependency-coverage/audit.json
npm run audit:dependency-reconcile -- --audit .tmp/dependency-coverage/audit.json --report .tmp/dependency-coverage/reconciliation.md
```

- The audit parser takes `--json --report <path>` only; `--format=json` and `--report=<path>` fail.
- `--prod` signs a site-data session with `SITE_SESSION_SIGNING_KEY`; `--api-base <url>` instead sends `DEPENDENCY_COVERAGE_API_KEY`, falling back to `PHAROS_API_KEY`. Check names only, never values.
- Record access date, publication generation and timestamp, supply timestamp, report counts, and whether inputs are production, local or fixture-derived. Keep the runbook's three identities separate: a newer capture or checkout never renews a held publication, missing legacy provenance is unknown, and malformed provenance rejects the report.
- If production is unavailable, label the local or fixture snapshot, leave production-only conclusions open, and never mutate production D1 or bypass admission guards.

## Monthly Decision Workflow

1. **Order.** Work unresolved items by dependent market cap, largest first; unknown market caps are listed separately, never as zero. Within a priority use ledger age and next-review triggers.
2. **Weekly failures first.** Triage a failed weekly invariant immediately using [Weekly Failure Versus Advisory Findings](../../../docs/runbooks/dependency-network.md#weekly-failure-versus-advisory-findings): `coinIdWithoutDepTypeCount` is zero-tolerance even during skew, while a `checkout-production-skew` status downgrades the checkout-sensitive counters to advisory until the publication matches the checkout.
3. **Triage each queue from its emitting source.**
   - Adapter gaps: verify which mappings actually produce dependencies; add or refresh their dated `adapterReview(...)` entries in the same change as the mapping fix.
   - Target dispositions: resolve invalid, expired or newly scoreable targets with current publication evidence; recheck an intentional gap when its trigger fires.
   - Material unlinked slices: establish exact claim identity and the right denominator, then measure the backing share. Protocol-wide assets, LP debt and borrow-market collateral are not dependent backing.
   - Symbol leads: verify chain, contract, issuer and claim form; a symbol match is only a lead.
   - Duplicate/split groups: separate duplicate claims from additive measured positions in the same upstream; never deduplicate by label.
   - Unverifiable published edges: refresh primary evidence, retarget to the verified claim, or withhold. The seed ledger's captured publication is not a verification.
4. **Verify.** Use dated primary issuer, contract, API or on-chain evidence, bound to an access date and, on-chain, a stated block. Record numerator, denominator, measurement time and source scope for every weight. Look through a bridge or intermediary only when its escrow or claim relationship is verified.
5. **Decide and record.** Use the runbook's decision vocabulary and append one dated ledger decision per reviewed claim group; reopening appends, never deletes. Deferrals carry a concrete next-review date or event. Withholding lands through the normal review and admission path, not by editing audit output.
6. **Check the fund link.** An edge to a `tokenized-fund` can be that fund's only [retention link](../../../docs/listing-policy.md#tokenized-fund-retention). Before withholding or retargeting one, report whether another active non-fund asset still links the fund; do not delist it here.

A drain that edits `shared/data/safety-score-v9/evidence-gap-classifications-v1.json` hands that file to the [safety-score-curation](../safety-score-curation/SKILL.md) skill's checks.

## Documentation And Validation

Update routed docs for changes to mapping semantics, queues or admission rules. Methodology-affecting changes follow [ADR-3](../../../docs/architecture.md#adr-3); evidence-only changes get no invented scoring revision.

Run focused tests for the changed producer and admission surfaces, `npm run check:stablecoin-data`, and `npm run check:dependency-review-gaps`. Repeat the capture and reconciliation after publication. Use `pharos-release-runner` only when publication is requested.

## Output And Hard Stops

If all queues are empty, report source, date and zero counts, then stop. Otherwise report reviewed outcomes, changes by file, dated evidence, checks actually run, deferred prerequisites and triggers, remaining queue counts, the oldest unresolved first-seen date and oldest reviewed deferral, weekly failure risk, and the date the next monthly drain is due.

- Never create an edge from a lead alone, invent a weight, or bypass a missing target card.
- Never replace a failed live mapping with stale curated weights to recover coverage.
- Never change supply sources or weaken global scoring or admission gates to close the queue.
- Never claim a verification from an old snapshot, or bump `reviewedAt` without a new review.
