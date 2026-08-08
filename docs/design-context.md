# Design Context

> Canonical human-facing source. The root [`DESIGN.md`](../DESIGN.md) is the machine-readable mirror (Stitch format, for AI agents generating screens), kept faithful to the **as-built code**: frost-blue + the drawn lighthouse identity are retained, with the Figma redesign's global top-nav (the left "watch column" sidebar retired). A Figma handoff proposed a neutral/Radix repaint; the owner's final call (2026-06-27) kept frost-blue. Regenerate `DESIGN.md` with `/impeccable document` when tokens or the homepage composition change.

## Users

Crypto-native DeFi participants who actively monitor stablecoin health — checking market conditions, peg stability, and risk signals regularly to inform financial decisions. The core audience is power-user-leaning: they value density, precision, and speed-to-insight over softness or consumer-app hand-holding.

Discovery and onboarding surfaces (`/start/`, first-run callouts, `/about/`, `/api/` public landing, `/learn/mechanisms/`) deliberately soften their layout and lead with warmer kicker copy to welcome newcomers, but the data surfaces they hand off to stay practitioner-grade. The drift is in the _funnel_, not in the _product core_.

## Brand Personality

**Vigilant, precise, distinctive.** Pharos is a lighthouse — it watches every peg so you don't have to. The tone is practitioner-built, not corporate, and the product should feel unmistakable rather than merely competent. It earns trust through completeness and specificity, but it should also carry a unique vibe that separates it from generic analytics dashboards.

## Emotional Design

**Calm by default, urgent when needed.** The steady state is composed and analytical — the user feels informed and in control. When risk signals fire (depeg events, DEWS alerts, PSI band shifts), the interface shifts tone to communicate urgency without panic.

## Surface Tiers

Pharos calibrates density and tone to surface intent across three explicit tiers. Use this table to place new work; do not blend tiers within a single surface.

| Tier           | Routes / Surfaces                                                                                                                                                     | Density | Tone                                                  | Layout signal                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Discovery**  | `/start/`, `/about/`, `/api/` public landing, `/learn/mechanisms/`, marketing-adjacent shells                                                                         | Lowest  | Warmer kicker copy permitted; inviting framing        | Larger rounded shells, generous whitespace, fewer controls, step explainers, route boards |
| **Analytics**  | Homepage dashboard, `/depeg/`, `/chains/`, `/liquidity/`, `/freezewatch/`, `/yield/`, `/coverage/`, `/alt-pegs/`, `/safety-scores/`, `/upcoming/`, `/digest/` archive | Default | Composed, analytical, factual                         | `pharos-card-shell`, KPI grids, charts, sortable tables, control pills                    |
| **Power-user** | `/stablecoin/[id]/`, `/compare/`, `/screener/`, `/timeline/`, `/portfolio/`, ops admin                                                                                | Highest | Maximum information per pixel; assumes domain fluency | Dense tables, minimal chrome, hairline dividers, mono-heavy, multi-pane composition       |

The gradient runs Discovery → Analytics → Power-user. Drift between adjacent tiers is acceptable when justified by the surface's actual user intent; jumps across tiers (warm copy on `/timeline/`, marketing-style soft chrome on `/screener/`, or dense multi-pane composition inside `/start/`) are not.

## Aesthetic Direction

- **Theme**: Light theme by default, with the same dense financial-dashboard hierarchy preserved in dark mode
- **References**: DeFi-native research products with strong data density and practical crypto analytics, but Pharos should not collapse into looking like another interchangeable dashboard
- **Brand accent**: Frost-blue `#4BC4DE`, sampled from the Figma Market Pulse frame — used sparingly for navigation active states, homepage metrics, and brand touches
- **Fonts**: Geist Sans for core UI, JetBrains Mono for data figures, and the tracked Bricolage Grotesque face for display. Intentional non-core carve-outs include Newsreader serif for editorial/tombstone surfaces, Georgia serif for `AiSummary` and route error treatments, Courier New for Digest/depeg editorial body copy, and the Tape `/timeline/` mono-token wire-service stream.
- **Color use**: Semantic first — color communicates state (health, risk, trend direction), not empty decoration
- **Design bar**: Avoid generic SaaS sameness; every major surface should feel authored and recognizably Pharos

## Anti-References (what Pharos must NOT look like)

- **Web3 marketing pages**: Purple gradients, glassmorphism, buzzword-heavy, style over substance
- **Corporate fintech**: Sterile, over-polished, feels like a bank app — no personality
- **Generic SaaS dashboards**: Cookie-cutter admin panels with big empty cards, interchangeable KPI tiles, and safe pastel gradients
- **Derivative crypto analytics clones**: Anything that feels like a reskinned DefiLlama or generic trading terminal without its own point of view
- **Consumer-app over-softening**: Discovery surfaces soften their _layout and kicker copy_, not their _data_. Charts, tables, and numbers stay analytical on every tier — no chunky illustrations or onboarding mascots inside data surfaces.

## Design Principles

1. **Data density over decoration** — every pixel earns its place by communicating information
2. **Calibrate density to surface intent** — Discovery surfaces breathe and lead with warmer kicker copy; Analytics surfaces hold the default; Power-user surfaces compress. Do not apply a single density everywhere.
3. **Calm authority, not loud urgency** — steady state is composed; risk signals shift the tone
4. **Precision as personality** — monospace numbers, exact percentages, named bands — trust through specificity
5. **Semantic color only** — color communicates state (health, risk, trend), never decoration
6. **Soften the funnel, not the product** — onboarding and discovery can welcome with warmer language and roomier layouts; data surfaces remain crypto-native and practitioner-grade
7. **Distinctive, not generic** — Pharos should feel authored and memorable, never like a template or a clone. When a page introduces a metaphor, _draw it_ (Cemetery, Alt-Peg Atlas, Chains Harbor) — but every shape must encode a data field
8. **Consistency is polish** — premium feel comes from repeated precision in spacing, shell treatment, controls, and empty/error states, not from adding decorative novelty

## Stablecoin Detail Module Contract (2026-08-08)

Every scored/evidence module on `/stablecoin/[id]/` compiles to one shape (owner decisions, 2026-08-08):

- **Header**: `DETAIL_MODULE_*` constants + `DetailSectionTitle` with `MethodologyLabel`; right slot order is score (`ScorePill`) → status chip → freshness (`FreshnessIndicator`).
- **Summary layer** (always visible): verdict line, bounded-vocabulary facts (`FactGrid`, the hero passport grammar), at most one primary visual, and **current-state** callouts only.
- **Detail layer**: breakdowns, tables, long prose, and historical incidents fold behind `ModuleDisclosure` (named labels, native `<details>`), collapsed by default **at every breakpoint** — desktop included. The one sanctioned auto-open is the weakest Safety Score pillar at `lg+`.
- **Footer**: `EvidenceFooter` — one line of methodology links, folded `Sources (N)` (collapsed everywhere, kept in the DOM for crawlers), right-aligned reviewed/updated stamp.
- **Semantic color**: red/amber callouts are reserved for *active* state; resolved incidents render as calm folded history.
- The xl summary rail keeps expanded at-a-glance compact cards (its purpose *is* the summary layer); below xl, rail-only content must have an in-flow `xl:hidden` copy — never amputated.
