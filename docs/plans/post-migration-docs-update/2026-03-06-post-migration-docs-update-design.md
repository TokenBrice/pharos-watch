# Design: Post-Migration Documentation Update

**Date:** 2026-03-06
**Status:** Ready for execution

## Problem

The ticker-issuer ID migration (Phase 3 deployed 2026-03-06) changed all stablecoin IDs from numeric/prefixed formats to canonical `ticker-issuer` format. The code and database are fully migrated, but 10 active documentation files still reference the old ID system — stale examples, wrong format descriptions, and outdated ID decision trees.

## Goal

Update all active documentation to reflect the canonical `ticker-issuer` ID system so that any developer or future orchestrator reading the docs gets accurate information about how stablecoin IDs work.

## Scope

**In scope (10 files):**

| File | Severity | Stale content |
|------|----------|---------------|
| `docs/api-reference.md` | High | ID format table (lines 17-24) shows old formats; example line 1388 uses `/stablecoin/1` |
| `docs/process/adding-a-stablecoin.md` | High | Entire Phase 1 (ID determination), Phase 4 (logo naming), Phase 7 (backfill), ID decision tree — all built around old `cg-`/numeric system |
| `docs/mint-burn-flows.md` | High | Contract config table (lines 63-139) uses old IDs for ~80 entries |
| `docs/classification.md` | Medium | Line 74: "synthetic IDs (e.g., `gold-xaut`, `silver-kag`, `cg-jpyc`)" |
| `docs/supply-snapshot.md` | Medium | Line 62: describes `stablecoin_id` as "DefiLlama numeric ID" |
| `docs/dews.md` | Medium | Line 176: example `?stablecoin=1` |
| `docs/status-dashboard.md` | Medium | Line 166: example `?stablecoin=1` |
| `docs/cemetery-and-compare.md` | Medium | Line 52: "numeric stablecoin IDs (primary format)" |
| `docs/scripts.md` | Low | Line 41: `gold-xaut`, `gold-paxg` |
| `docs/runbooks/mint-burn-ingestion.md` | Low | Lines 15-19: old numeric IDs for CCIP configs |

**Out of scope:**
- `docs/plans/historical/ticker-issue-migration/` — historical migration docs, left as-is
- `docs/research/` — historical audit logs, left as-is
- `docs/plans/future/` — speculative designs, left as-is
- Code changes (scripts, source) — separate task

## ID Format Reference

All documentation should use these canonical examples:

| Old ID | Canonical ID | Context |
|--------|-------------|---------|
| `"1"` | `"usdt-tether"` | USDT |
| `"2"` | `"usdc-circle"` | USDC |
| `"5"` | `"dai-makerdao"` | DAI |
| `"119"` | `"fdusd-first-digital"` | FDUSD |
| `"122"` | `"gyen-gyen"` | GYEN |
| `"gold-paxg"` | `"paxg-paxos"` | PAX Gold |
| `"gold-xaut"` | `"xaut-tether"` | Tether Gold |
| `"silver-kag"` | `"kag-kinesis"` | Kinesis Silver |
| `"cg-ustb"` | `"ustb-superstate"` | Superstate USTB |
| `"cg-ousg"` | `"ousg-ondo-finance"` | Ondo OUSG |
| `"cg-jpyc"` | `"jpyc-jpyc"` | JPYC |

The canonical format is `{ticker}-{issuer}`, lowercase, hyphen-separated. See `shared/lib/stablecoins.ts` for the full list.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Incorrect canonical ID in docs | Every ticket includes a grep-based verification step against the actual codebase |
| Missed stale reference | Acceptance criteria include exhaustive grep for old patterns |
| Doc drift from code | Tickets reference live source files for ground truth, not the mapping table |
