# Start Page

Route contract for `/start/`, the onboarding and route-selection surface.

---

## Route Shape

- **Server route:** `src/app/start/page.tsx`
- **Main content component:** `src/components/start-here-page.tsx`
- **Start Here shortcut retirement marker:** `src/components/start-here-visit-marker.tsx`
- **Curated content registry:** `src/lib/start-here-content.ts`

`src/app/start/page.tsx` renders:

1. `StartHereVisitMarker`
2. `StartHerePage`

The route is static. It does not call worker APIs directly.

`src/app/start/page.tsx` also authors route metadata through `buildPageMetadata(...)` with canonical `/start/` and `https://pharos.watch/og-start.png` as the Open Graph image.

---

## Homepage Integration

`StartHereVisitMarker` is the bridge between `/start/` and the shared onboarding-retirement state used by the shell navigation shortcut.

On mount it:

- reads the current Start Here localStorage state
- applies `markStartHereOpened(...)`
- writes the updated state back

This persisted flag retires the shell-level `Start Here` shortcut in the mobile nav for repeat sessions. (The desktop top nav does not surface a Start Here entry at all.)

---

## Shared Shell Contract

`StartHerePage` uses `FeaturePageShell` with:

- `breadcrumbName = "Start Here"`
- `path = "/start/"`
- `title = "Start Here"`
- `containerClassName = "mx-auto max-w-6xl"`

Unlike the homepage, `/start/` is a guided long-form route with standard breadcrumb/title chrome above the route-specific onboarding content.

---

## Content Registry Contract

The goal/glossary/atlas/shortcut content lives in `src/lib/start-here-content.ts`. The route-local PharosVille companion block is authored directly in `src/components/start-here-page.tsx` because it is presentation-specific and not part of the reusable route registry.

The page consumes five exported datasets:

- `START_HERE_GOALS`
- `START_HERE_SCORES`
- `START_HERE_GLOSSARY`
- `START_HERE_ATLAS`
- `START_HERE_SHORTCUTS`

These are the canonical source of truth for the route destinations, copy, and grouping used by the guided route sections.

---

## Section Order

`StartHerePage` renders sections in this order:

1. Hero route deck
2. `How Pharos scores risk` scores section
3. `How to read Pharos` glossary section
4. `Feature atlas` section
5. `Power moves` shortcuts section
6. `Sister tool: PharosVille`
7. Closing CTA with `Open the dashboard`, `Read the methodology`, and `browse the directory` links

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
- `/portfolio/`
- `/yield/`
- `/pharoswatchbot/`

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
