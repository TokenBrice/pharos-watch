# Blacklistable Status End-to-End Audit

Date: 2026-03-30

## Scope

Reviewed the shared blacklistability resolver, the report-card snapshot propagation path, consumer call sites, related methodology/docs, and the targeted test coverage.

## Verification

- `npm test -- shared/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`
- Local `tsx` checks against the current metadata set to compare naive `isBlacklistable(meta)` with the transitive report-card-style resolution loop.

## Findings

### High

1. Several product surfaces still bypass the fully resolved blacklist status.
   - `src/components/stablecoin-table.tsx`
   - `src/components/stablecoin-table-logic.ts`
   - `src/components/stablecoin-detail/hero-card.tsx`
   - `src/components/blacklist-status-charts.tsx`
   - `src/lib/page-metadata.ts`
   - `src/lib/compare-pages.ts`
   - Current metadata audit: `11` active coins differ between naive `isBlacklistable(meta)` and the transitive snapshot resolution. Static metadata/copy helpers are even weaker because they only inspect `coin.canBeBlacklisted`.

2. Transitive inheritance is still only a single pass over a pseudo-topological order, so cyclic reserve graphs remain order-dependent.
   - `worker/src/lib/report-cards-snapshot.ts`
   - `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`
   - The current tests cover cycle termination, not fixed-point correctness. A simple two-coin cycle with one inherited seed reproduces a false negative for the earlier-processed node.

### Medium

3. Curated reserve detection is not future-open in the same way as live reserve detection.
   - `shared/lib/report-card-blacklist-risk.ts`
   - Live slices get dynamic symbol enrichment from the growing blacklistable set; curated slices only get `coinId`, explicit `blacklistable`, or hardcoded regex buckets. A newly added blacklistable coin referenced by name in curated reserves will still need manual `coinId` curation or a new regex.

4. The implementation and docs disagree about the live-reserve blacklist path.
   - `docs/live-reserves.md`
   - `docs/report-cards.md`
   - Code now uses enriched live slices for blacklist attribution, but `docs/live-reserves.md` still says blacklist-inherited checks only use curated metadata.

### Low

5. The resolver API shape encourages misuse and the current tests do not guard consumer alignment.
   - `shared/lib/report-card-blacklist-risk.ts`
   - Optional arguments make `isBlacklistable(meta)` mean a materially different thing from the worker-resolved status, which is how the weaker call sites slipped in.

6. Live symbol enrichment uses raw substring matching and rebuilds its symbol map on every call.
   - `shared/lib/report-card-blacklist-risk.ts`
   - This is small today, but token-aware matching and precomputed matchers would reduce future collision risk and avoid repeated work.

## Overall Assessment

The core shared resolver is much better than the earlier versions and the current data set is materially more coherent. The remaining risk is mostly architectural: the project does not yet enforce a single resolved blacklist status across all consumers, and the future-proofing story still depends on curated `coinId` links, hardcoded text heuristics, and an acyclic dependency graph.
