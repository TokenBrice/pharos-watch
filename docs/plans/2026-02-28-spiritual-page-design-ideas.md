# Spiritual Page Design Ideas

> **Goal**: Align each page's visual design with its *spirit* — the way the Digest (broadsheet newspaper) and Cemetery (memorial with tombstones, weathering, epitaphs) commit fully to a metaphor at every level: typography, layout, interaction, language, color.
>
> **The gap**: All 7 target pages currently share the same card + table + Recharts grammar. Except for the Stability Index lighthouse, they could swap designs without anything feeling wrong.

---

## What Makes the Exemplars Work

### Digest — "The Broadsheet"
- **Serif font switch** (Georgia) — the only page that abandons the system sans-serif
- **Masthead** with `tracking-[0.25em]` uppercase — newspaper nameplate
- **Double-rule dividers** with centered labels — broadsheet section separators
- **Wire table** with `font-mono` uppercase dates ("27 FEB") — telegraph/ticker aesthetic
- **Italic body text** at `1.15rem` — magazine column feel
- **Arrow entities** (`←` / `→`) for prev/next — print pagination, not button components
- **No shadcn Card/Badge/Table** in the article area — deliberate restraint

### Cemetery — "The Memorial"
- **Tombstone silhouettes** with arch radius scaled to peak market cap
- **Cause-of-death shapes**: cross (abandoned), hammer SVG (regulatory), plain arch (other)
- **Weathering system**: CSS brightness dims + green moss box-shadow grows with age
- **Grayscale logos** — color only returns on hover; dead = gray
- **Epitaph inscriptions** in italic at 70% opacity
- **Stagger + tilt grid** — uneven, realistic graveyard rows
- **"Press F to pay respects"** — SVG flower accumulation mechanic
- **Ground gradient** — `emerald-950/15` faint grass under the tombstones

### The Pattern
Both pages pick a single metaphor and commit to it in typography, spatial layout, color palette, interaction design, and language. Every element reinforces the identity. Nothing is generic.

---

## 1. Stability Index

**Spirit**: Monitoring tectonic stress beneath the surface. The condition bands (BEDROCK, TREMOR, FRACTURE, CRISIS, MELTDOWN) are already geological — the design should be too.

### a) Seismograph Hero
Replace the static score display with a live seismograph needle trace. A thin line draws continuously left-to-right across the hero card, trembling gently in BEDROCK conditions, oscillating wildly during FRACTURE/CRISIS. The current PSI value is the needle's amplitude. Not a chart — a single, endlessly-drawing instrument readout, like a hospital heart monitor for the stablecoin market. The lighthouse stays but becomes a secondary icon, not the hero.

**Key elements**: Canvas or SVG `<path>` that extends in real-time via `requestAnimationFrame`. Amplitude mapped to PSI. Line color matches current condition band. Faint grid paper background behind the trace. The needle resets (wraps) when it reaches the right edge.

### b) Geological Strata History
Restyle the PSI history chart to look like a geological cross-section / core sample. The colored condition bands aren't flat horizontal stripes — they're layered sedimentary strata with slightly irregular, organic edges (SVG paths with subtle noise / perlin-style wobble). The PSI line cuts through them like a drill core. Crisis events are rendered as **fault lines** — diagonal fracture marks cutting across the strata with displacement, not just labeled rectangles.

**Key elements**: Custom SVG `<path>` shapes for each band boundary instead of Recharts `<ReferenceArea>`. Fault line SVG marks at crisis events with slight horizontal displacement. Subtle rock-texture hatching pattern (CSS) per band. The chart reads like a geology textbook illustration.

### c) Atmospheric Tension Background
The page background subtly shifts based on the current condition band:
- **BEDROCK**: Faint, clear gradient — almost invisible
- **STEADY**: Barely perceptible cool blue tint
- **TREMOR**: Faint warm haze
- **FRACTURE**: Subtle amber atmospheric noise texture
- **CRISIS**: Hairline crack patterns (SVG) begin radiating from the hero card outward
- **MELTDOWN**: Crack pattern intensifies, faint red pulse at the edges

Very subtle, never distracting. You *feel* the tension level before reading a single number. The page itself is the instrument.

**Key elements**: CSS `background-image` or absolutely-positioned SVG overlays that transition with the band. Cracks as thin SVG `<line>` elements with `stroke-dasharray` animation. Entire effect at <10% opacity — atmospheric, not decorative.

---

## 2. Safety Scores

**Spirit**: Judgment — who passes inspection, who doesn't, and what happens when the system is stressed.

### a) Crash Test Rating (NCAP-style)
Like Euro NCAP or IIHS car crash tests. Each stablecoin has been "crash-tested" across 5 dimensions. The mini-card grade badges are restyled as impact shields — intact (A), hairline cracks (B), visibly cracked (C), shattered (D/F). The grade distribution bar at top becomes a row of crash-test silhouettes color-coded by outcome. The stress test simulator is reframed as a "crash scenario lab" — you pick which wall to drive into and watch damage propagate through the fleet.

**Key elements**: Shield icon SVGs with progressive damage states. "Crash Lab" heading for stress test panel. Impact terminology: "absorbed," "structural failure," "total loss." The mini-card border gains a subtle shatter-crack SVG texture for lower grades.

### b) Building Inspection Placards
Inspired by the A/B/C health inspection grades posted on NYC restaurant windows. Each mini-card is styled as an official inspection placard — a thick-bordered document with an oversized grade letter, a "Date of Assessment" line in small type, and a subtle official-seal watermark (circular SVG with "PHAROS SAFETY COMMISSION" text on a path). The page header shifts to institutional typography — spaced uppercase, slightly serif. The stress test becomes a "structural failure simulation" with blueprint-grid backgrounds.

**Key elements**: Placard border (`border-2`, slightly rounded, off-white interior). Watermark as a low-opacity circular SVG seal. Institutional header: "PHAROS SAFETY COMMISSION" in `tracking-widest`. Grade letter at `text-5xl` or larger — the placard *is* the grade. Date of assessment line adds temporal authority.

### c) Triage Tags
Emergency medicine triage system. Each coin gets a triage tag — a tag-shaped element (CSS `clip-path` trapezoid or angled corner) color-coded by grade:
- **A** = Green tag (immediate discharge — no concerns)
- **B** = Yellow tag (delayed — minor issues)
- **C** = Amber tag (urgent — needs attention)
- **D** = Red tag (immediate — critical intervention needed)
- **F** = Black tag (expectant — do not resuscitate)

The page is a field hospital after a market event. The stress test becomes a mass casualty simulation: "If USDT fails, how many coins move from green to red?" The language shifts throughout: "triaged," "critical," "stable condition," "code black."

**Key elements**: Tag-shaped mini-cards (angled top-left corner via `clip-path`). Color-coded tag stripe on left edge matching triage color. Medical terminology in labels. Stress test header: "Mass Casualty Simulation." Status indicators pulse for critical-grade coins.

---

## 3. Dependency Map

**Spirit**: The invisible infrastructure that everything rests on — cut one line and regions go dark.

### a) Submarine Cable Map
Inspired by the [TeleGeography Submarine Cable Map](https://www.submarinecablemap.com/). Dependencies are thick, gently curving cable lines (cubic bezier curves, not straight lines) with colored sheaths. Cable thickness = dependency weight. Collateral cables = deep blue, mechanism cables = amber, wrapper cables = violet. Nodes become "landing stations" — small circular ports with a clean coin logo inset. The background has a subtle bathymetric contour texture (faint curved lines suggesting ocean floor topography).

Hovering a cable lights it up and shows capacity/weight. Hovering a landing station highlights all cables connecting to it. The metaphor: this is the invisible infrastructure under the ocean of DeFi. Cut one cable and entire regions go dark.

**Key elements**: Cubic bezier edge paths instead of straight `<line>` elements. Thicker strokes (3-8px) with rounded caps. Bathymetric contour SVG pattern as background. Node circles with subtle port/dock ring styling. Dark blue-gray color palette overall — oceanic.

### b) Power Grid / Circuit Board
The graph is restyled as an electrical schematic. The largest coins (USDT, USDC) are power plants / transformers — large prominent nodes with transformer/generator iconography. Smaller coins are substations or endpoints. Edges are power lines with rigid right-angle routing (like PCB traces — horizontal then vertical, no diagonals). Connection points have visible junction dots.

When you hover a major node, everything downstream "lights up" — everything else dims as if unpowered. A node removal simulation dims everything downstream to show cascade failure — the lights go out.

**Key elements**: Right-angle edge routing (orthogonal paths). PCB-trace aesthetic — thin lines with sharp corners and junction dots. Node icons differentiated by role (generator, transformer, endpoint). Hover = "power on" animation (glow propagation along edges). Dark background with faint grid lines (engineering paper).

### c) Root System / Mycelium Network
Flip the conceptual orientation. The biggest coins are the visible canopy/trunk at the top. Dependencies spread downward like roots — organic, curved, branching. Wrapper dependencies are fine root hairs. Collateral dependencies are thick taproots. The background has a subtle soil-texture gradient (lighter at top, earthier/darker at bottom).

When you hover a root node, you see what it nourishes above — a glow propagates upward through the root network. The metaphor: ecosystem health depends on what's underground and invisible. A mycorrhizal network where nutrients (collateral) flow between organisms.

**Key elements**: Top-to-bottom layout (not force-directed — hierarchical). Organic cubic bezier curves with slight randomization in control points. Root-hair thin lines for minor dependencies. Soil gradient background. Earthy color palette: browns, greens, ochres. Hover glow propagates directionally (bottom → top).

---

## 4. Portfolio

**Spirit**: Seeing through the surface — what you *think* you hold vs. what you're *actually* exposed to.

### a) X-Ray / MRI Scan
Your portfolio is a patient. The default view shows the "surface" — your direct holdings as clean, solid blocks with their individual grades. A toggle switches to "X-ray mode" and the view transforms: a dark background with scan-line overlay, the holdings become translucent, and the upstream collateral chain glows through underneath — USDC backing visible through DAI, Treasury exposure visible through USDC.

The radar chart becomes a medical scan display — concentric rings on dark background with characteristic blue-green MRI glow. Warnings become medical alerts: "CRITICAL: 82% single-point exposure to USDC." The grade is a "vitals readout." The entire card gets a subtle scanline/phosphor overlay in X-ray mode.

**Key elements**: Toggle between "Surface" and "X-ray" view modes. Dark background + scanline CSS overlay in X-ray mode. Translucent holdings with glowing upstream exposure visible through them. Medical alert styling for warnings (red cross icon, "CRITICAL" prefix). Vitals-monitor aesthetic for the grade display (monospace, blinking cursor after the value).

### b) Iceberg Visualization
A literal iceberg cross-section. Above the waterline: your direct holdings — the coins you chose, their amounts, their grades. Clean, visible, knowable. Below the waterline: the iceberg widens to show upstream exposure — what you're actually resting on. The wider the submerged base, the more diversified your true exposure. A narrow base (concentrated upstream) = top-heavy, unstable iceberg.

The water line is a horizontal divider with a subtle wave animation. The exposure bars become horizontal layers of the submerged portion, with depth indicating how many dependency layers removed the exposure is. The grade badge sits at the iceberg's peak.

**Key elements**: SVG iceberg silhouette that reshapes based on actual exposure data. Waterline with CSS wave animation. Above-water section = direct holdings (clean white/blue). Below-water section = upstream exposure (darker blues, increasing opacity with depth). Width of submerged layers = proportional to exposure percentage. Top-heavy vs. broad-base visual is immediately readable.

### c) Building Cross-Section
Your portfolio as an architectural cutaway drawing. Your holdings are the visible floors of the building above ground. Below ground, the foundation cross-section reveals upstream exposure — what your building actually stands on. A building resting on a single deep pillar (90% USDC exposure) looks visibly precarious compared to one on broad, distributed pilings.

Hairline cracks appear in the foundation where concentration risk exceeds thresholds. The grade becomes an engineer's certification stamp (circular, official-looking). The aesthetic is technical drawing — thin precise lines, hatching patterns for different exposure types, dimension labels with leader lines.

**Key elements**: SVG building cross-section that adjusts proportions to real data. Hatching patterns (diagonal lines) for different upstream coins. Crack SVGs at high-concentration points. Blueprint-style background (faint blue grid). Engineer's stamp watermark for grade. Dimension labels showing percentages.

---

## 5. Freeze Tracker (Blacklist)

**Spirit**: Watching power being exercised — surveillance of issuer authority over user funds.

### a) Surveillance Terminal (SOC Aesthetic)
Dark background. Monospaced amber or green-on-black text, like a Security Operations Center terminal. Each freeze event is a "CAPTURE" with a timestamp in fixed-width `HH:MM:SS UTC` format. The event table becomes a scrolling terminal log — newest events at top, each line prefixed with a status indicator. The most recent entries have a faint blinking cursor.

The stat cards become terminal readout panels with blocky, LED-segment-style numbers (CSS `font-variant-numeric: tabular-nums` + custom monospace). The quarterly chart renders with sharp edges and a faint scanline overlay. The aesthetic says: you are watching a surveillance feed of issuer power being exercised. Because that's literally what this page is.

**Key elements**: Dark mode forced (not system-dependent) for the main content area. Amber/green monospace text (`font-family: 'IBM Plex Mono', monospace`). LED-segment number styling for stat values. Terminal-log layout for event table (no alternating row colors — uniform dark rows with dim borders). Faint CRT scanline overlay (CSS `repeating-linear-gradient`). Timestamps in `HH:MM:SS` format. "CAPTURE" / "EVENT" / "ALERT" prefixes on log entries.

### b) Court Record / Legal Docket
Serif typography shift (like the Digest, but for legal authority rather than editorial voice). Each event is a numbered case entry:

> **CASE #2024-0847** · USDT · Tron · BLACKLIST · $2,400,000

The page header becomes an official document masthead — "PHAROS REGISTRY OF ISSUER ACTIONS" in spaced uppercase serif with double-rule borders (cf. Digest masthead pattern). Event type badges become legal stamps: `FROZEN` in red block letters, `RELEASED` in green, `DESTROYED` in black with a strike-through.

The stat summary becomes a "Clerk's Summary" box. The chart is captioned "Exhibit A — Quarterly Enforcement Activity." This commits to the idea that freeze events are legal acts of power deserving formal documentation.

**Key elements**: Serif font (Georgia) for event descriptions and headers. Case numbering system (sequential, zero-padded). Legal stamp badges (all-caps, bordered, colored by type). Double-rule masthead with official title. "Exhibit" labels on charts. Off-white parchment-tinted background for the content area. Official seal watermark.

### c) Redacted Intelligence Briefing
The page looks like a declassified government document. The header has a diagonal "DECLASSIFIED" stamp (rotated text, red border). Addresses are shown with a subtle redaction-bar aesthetic for the middle portion (dark bar over the truncated section — already common UX for address truncation, but now it *looks* like deliberate redaction).

Each event has a classification level based on frozen value:
- **ROUTINE** (<$100K) — unmarked
- **NOTABLE** ($100K–$1M) — yellow sidebar
- **SIGNIFICANT** ($1M–$10M) — orange sidebar
- **CRITICAL** (>$10M) — red sidebar, bold

The stat cards have faint "CONFIDENTIAL" watermarks. The page sits on a slightly off-white, paper-textured background. This reframes freeze events as intelligence — acts of state-like power that require clearance to understand.

**Key elements**: Paper texture background (subtle CSS noise or SVG pattern). "DECLASSIFIED" stamp (rotated, semi-transparent, red). Classification level badges per event. Redaction-bar styling on truncated addresses. "CONFIDENTIAL" watermarks on stat cards. Typewriter-style monospace for event metadata. Document margins and spacing.

---

## 6. Compare

**Spirit**: Making a decision between contenders — there should be winners, losers, and a verdict.

### a) Tale of the Tape (Boxing Weigh-In)
When comparing 2 coins, the layout transforms into a fight card. Left coin vs. right coin, logos face-to-face across a center divider. Each metric is a "round" — a horizontal bar that stretches from center toward the winner's side. Color intensity reflects margin of victory. The overall winner gets a subtle belt/crown icon.

For 3+ coins, it becomes a tournament/leaderboard — each metric row shows colored segments stretching proportionally. The radar chart overlay shows reach advantage. The page header displays the matchup: "USDC vs DAI" in fight-card typography (bold condensed uppercase).

**Key elements**: Center-divider layout for 2-coin comparison. Horizontal tug-of-war bars per metric (stretching left or right from center). Winner indicators (subtle glow, checkmark, or crown on the winning side). Fight-card header typography (condensed, uppercase, large). Coin logos face-to-face across the divide. Round-by-round annotations ("Peg Stability: USDC wins by 12 points").

### b) Trading Cards / Collectibles
Each selected stablecoin renders as a collectible trading card. The card has:
- A holographic-shimmer border effect (CSS animated gradient) whose color matches the coin's grade
- A hero logo area with a subtle background pattern unique to the coin's peg type
- Key stats in a structured stat block at the bottom (like a Pokémon card's HP/attacks)
- A "rarity" indicator based on market cap tier (Common / Uncommon / Rare / Legendary)

Cards fan out like a hand when selected. The comparison becomes "lay your cards on the table" — stats align across cards for scanning. A-grade cards have a visible shine effect; F-grade cards look worn (reduced saturation, rough edges). Cards are directly shareable as images.

**Key elements**: Card-shaped containers with rounded corners and thick borders. CSS holographic gradient animation on border (shifting hue based on scroll/mouse position). Stat block grid at card bottom. Rarity badge (star count or tier label). Fan-out layout (CSS transforms with slight rotation per card). Worn/pristine visual states based on grade. `html2canvas`-friendly for image export.

### c) Dossier / Intel File
Each coin gets a manila-folder / case-file treatment. Selecting a coin opens a tabbed folder with a typed label on the tab. Inside: a structured intelligence brief — classification, key metrics, strengths (green), weaknesses (red), risk factors. The comparison table becomes a side-by-side "briefing table" with declassified-document aesthetics — monospace type, redline annotations where one coin is significantly weaker than another.

The preset cards become "case files" — pre-assembled dossiers for common comparison scenarios ("The Big Four: CASE FILE #001"). This reframes comparison from passive data to active intelligence gathering.

**Key elements**: Manila/kraft paper background tint for each card. Tab shape at top (CSS `clip-path` or pseudo-element). Typewriter-style headers. "CLASSIFIED" / "CASE FILE #XXX" labels on presets. Red/green annotation marks for weaknesses/strengths. Folder stack visual when multiple coins selected (slight offset/shadow between folders).

---

## Selection Guide

For quick reference — which ideas best match the "spirit-aligned design" pattern established by Digest and Cemetery:

| Page | Strongest Metaphor Commitment | Why |
|---|---|---|
| Stability Index | **(c) Atmospheric Tension** | The page itself becomes the instrument — you feel the state before reading it |
| Safety Scores | **(c) Triage Tags** | Visceral, maps perfectly to contagion simulator, distinctive visual shape |
| Dependency Map | **(a) Submarine Cable Map** | Beautiful precedent, organic curves, "invisible infrastructure" metaphor |
| Portfolio | **(b) Iceberg** | Instantly communicates "what you see vs. what's really there" |
| Liquidity | **(a) Depth Gauge / Tanks** | Water metaphor is already in the word "liquidity" — commit to it |
| Freeze Tracker | **(a) Surveillance Terminal** | The page IS surveillance — make it look like surveillance |
| Compare | **(a) Tale of the Tape** | Creates the narrative tension the page currently lacks |

> **Note**: These are the author's picks for strongest spirit alignment. The user may prefer different combinations. Several ideas could be combined (e.g., Atmospheric Tension background + Seismograph Hero for Stability Index).
