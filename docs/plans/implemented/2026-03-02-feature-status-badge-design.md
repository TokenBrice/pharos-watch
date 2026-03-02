# Feature Status Badge — Design Doc

**Date:** 2026-03-02
**Status:** Approved

## Problem

As features are iterated on in production, users have no signal about the maturity of a given page/feature. Adding a visible status indicator helps set expectations.

## Solution

A shared `FeatureStatusBadge` component placed inline next to the h1 title on each feature page.

## Component

**File:** `src/components/feature-status-badge.tsx`

**Props:**
- `status: 'mature' | 'experimental' | 'testing-in-prod'`
- `version?: string` — optional version string (safety-scores only, currently `v5.4`)

**Color scheme:**
| Status | Background | Text | Border |
|---|---|---|---|
| Mature | `bg-emerald-500/15` | `text-emerald-700` | `border-emerald-500/30` |
| Experimental | `bg-amber-500/15` | `text-amber-700` | `border-amber-500/30` |
| Testing in Prod | `bg-orange-500/15` | `text-orange-700` | `border-orange-500/30` |

**Version display:** When `version` is provided, renders two adjacent badges: `[Mature] [v5.4]`.

**Placement:** Inline in the h1 element using `flex items-center gap-3` on the h1.

## Status Assignments

| Page | Status | Version |
|---|---|---|
| `/stability-index` | Mature | — |
| `/safety-scores` | Mature | v5.4 |
| `/dependency-map` | Experimental | — |
| `/liquidity` | Mature | — |
| `/depeg` | Mature | — |
| `/blacklist` | Mature | — |
| `/portfolio` | Experimental | — |
| `/compare` | Mature | — |
| `/yield` | Testing in Prod | — |
| `/flows` | Testing in Prod | — |

## Implementation Steps

1. Create `src/components/feature-status-badge.tsx`
2. Update each of the 10 page files to import and use the badge inline in h1
