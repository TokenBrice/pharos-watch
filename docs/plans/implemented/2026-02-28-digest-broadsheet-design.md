# Digest Broadsheet & Wire Archive Redesign

**Date**: 2026-02-28
**Status**: Approved

## Goal

Redesign the digest presentation to evoke a broadsheet newspaper aesthetic for today's digest (used on both homepage and `/digest/` page), and add a wire-service style archive table with month navigation on the `/digest/` page.

## Design Decisions

- **Aesthetic**: Broadsheet editorial (FT/WSJ style) for today's digest, wire-service ticker for historical archive
- **Front page scope**: Today's digest only (no multi-column spread)
- **Wire columns**: Date + Title + PSI badge (colored by band) + Total Mcap
- **Navigation**: Month picker dropdown to filter the wire table
- **Tweet text field (`text`)**: Never rendered on the website — only used for Twitter posting

## Scope

### 1. Broadsheet Component (shared)

Used in two places:
- **Homepage**: Replaces current `DailyDigest` component (`src/components/daily-digest.tsx`)
- **Digest page** (`/digest/`): Replaces current intro text + shows today's digest above the wire table

#### Masthead
- "PHAROS DAILY DIGEST" in uppercase, `tracking-[0.25em]`, `text-sm font-semibold text-muted-foreground`
- Full date below: "Saturday, February 28, 2026" in regular weight
- Both centered
- Bordered top and bottom by thin horizontal rules (`border-border`)

#### Headline
- Digest title (e.g. "BEDROCK, Untroubled") in serif, `text-3xl font-bold`, left-aligned

#### Body
- Extended text paragraphs in serif italic (Georgia, 1.1rem, `leading-relaxed`) — same as current styling
- The `text` field (tweet) is **not** rendered

#### Footer (homepage only)
- "Read all previous recaps →" link (as current)
- Omitted on `/digest/` since the wire table is directly below

### 2. Wire Table (`/digest/` page only)

#### Divider
- Decorative double-rule divider with centered "ARCHIVE" label between broadsheet and wire table

#### Month Picker
- `<select>` dropdown styled as minimal button, showing "February 2026"
- Options dynamically built from available digest dates
- Defaults to most recent month with data

#### Table Rows
- Styled divs (not `<table>`) for responsive flexibility
- **Date**: `text-xs font-mono uppercase text-muted-foreground` — e.g. "27 FEB"
- **Title**: `text-sm font-medium`, truncated with ellipsis on small screens
- **PSI badge**: Small pill showing band name + score, colored by band (existing PSI band colors from `classification.ts`)
- **Mcap**: `text-xs font-mono text-muted-foreground` — e.g. "$234B"
- **Chevron**: Subtle right arrow
- Row separator: `border-b border-border/30`
- Hover: `bg-muted/20`
- Each row links to `/digest/{date}`

#### Mobile Responsive
- PSI badge and mcap stack below the title instead of inline
- Date stays left-aligned

### 3. API Enrichment

**Endpoint**: `GET /api/digest-archive`

The `input_data` JSON column already stores PSI and mcap data per digest. Changes:
- Parse `input_data` in the archive API handler
- Extract `stabilityIndex.score`, `stabilityIndex.band`, and `totalMcapUsd`
- Add to response as `psiScore: number | null`, `psiBand: string | null`, `totalMcapUsd: number | null`

No new DB queries needed.

### 4. Content Relocation

The current intro paragraphs on `/digest/` (explaining what the digest is, linking to Telegram) move below the wire table or into a subtle footer section. Returning users don't need them front and center.

## Files Affected

| File | Change |
|------|--------|
| `src/components/daily-digest.tsx` | Redesign as broadsheet component |
| `src/components/digest-archive-client.tsx` | Replace archive list with wire table + month picker |
| `src/app/digest/page.tsx` | Update layout: broadsheet + wire, relocate intro text |
| `worker/src/api/digest-archive.ts` (or inline handler) | Enrich response with PSI + mcap from `input_data` |
| `src/hooks/use-digest-archive.ts` | Update types for new response fields |
| `src/lib/types.ts` | Add new fields to `DigestArchiveData` type |
