# Start Page

Route contract for `/start/`, the onboarding and route-selection surface.

---

## Route Shape

- **Server route:** `src/app/start/page.tsx`
- **Main content component:** `src/components/start-here-page.tsx`
- **Homepage callout retirement marker:** `src/components/start-here-visit-marker.tsx`
- **Curated content registry:** `src/lib/start-here-content.ts`

`src/app/start/page.tsx` renders:

1. `StartHereVisitMarker`
2. `StartHerePage`

The route is static. It does not call worker APIs directly.

`src/app/start/page.tsx` also authors route metadata through `buildPageMetadata(...)` with canonical `/start/` and `https://pharos.watch/og-start.png` as the Open Graph image.

---

## Homepage Integration

`StartHereVisitMarker` is the bridge between `/start/` and the shared onboarding-retirement state used by both the homepage callout and the shell navigation shortcut.

On mount it:

- reads the current Start Here localStorage state
- applies `markStartHereOpened(...)`
- writes the updated state back

This is what retires the homepage Start Here CTA after the route has been visited once. The homepage-side behavior is documented in [Homepage](./homepage.md).
This same persisted flag also retires the shell-level `Start Here` shortcut in the desktop sidebar and mobile nav for repeat sessions.

---

## Shared Shell Contract

`StartHerePage` uses `FeaturePageShell` with:

- `breadcrumbName = "Start Here"`
- `path = "/start/"`
- `title = "Start Here"`
- `containerClassName = "mx-auto max-w-6xl space-y-8"`

Unlike the homepage, `/start/` is a guided long-form route with standard breadcrumb/title chrome above the route-specific onboarding content.

---

## Content Registry Contract

All authored route content lives in `src/lib/start-here-content.ts`.

The page consumes four exported datasets:

- `START_HERE_GOALS`
- `START_HERE_GLOSSARY`
- `START_HERE_ATLAS`
- `START_HERE_SHORTCUTS`

These are the canonical source of truth for route destinations, copy, and grouping. `src/components/start-here-page.tsx` is mostly presentation logic.

---

## Section Order

`StartHerePage` renders sections in this order:

1. Hero route deck
2. `How to read Pharos` glossary section
3. `Feature atlas` section
4. `Power moves` shortcuts section

### Hero route deck

The hero combines:

- editorial onboarding copy
- desktop/mobile `HeroEscapeHatch` support cluster
- route-selection board built from `START_HERE_GOALS`

Goal-card rules:

- each card represents a distinct user job, not a generic feature link
- goal cards render in a uniform responsive grid (`sm:grid-cols-2`, `xl:grid-cols-3`)
- each card carries its own primary route, CTA label, and destination chips

### Glossary

Built from `START_HERE_GLOSSARY`. This section is the only concept-first explainer on the page; everything else is route navigation.

### Feature atlas

Built from `START_HERE_ATLAS`. Groups are organized by user job:

- Monitor
- Research
- Operate
- Learn

### Power moves

Built from `START_HERE_SHORTCUTS`. These are workflow accelerators for repeat use, not primary onboarding steps.

---

## Navigation Contract

The route is curated around internal Pharos destinations only.

Current primary goal routes:

- `/`
- `/stablecoins/usd/`
- `/compare/`
- `/yield/`
- `/telegram/`

Support CTAs in the hero point to:

- `/`
- `/methodology/`

If onboarding priorities change, update the route registry in `src/lib/start-here-content.ts` rather than hard-coding links in the component tree.

---

## Responsive And Layout Rules

Key layout behavior from `src/components/start-here-page.tsx`:

- desktop hero uses a two-column planning-board layout
- mobile compresses the onboarding copy so the first goal card stays near the top fold
- desktop support content sits in a vertical stack under the headline
- follow-up sections use cards and flattened route groups instead of long prose

For visual-treatment rules, see [Design Language](./design-language.md).

---

## Update Rules

Update this doc when any of these change:

- section order
- the curated goal/atlas/shortcut route structure
- the homepage-callout retirement handshake
- the shared sidebar/mobile-nav retirement handshake
- the shared-shell contract for `/start/`

When changing onboarding copy or destinations, update `src/lib/start-here-content.ts` in the same change. If the homepage CTA behavior changes too, update [Homepage](./homepage.md) alongside this document.
