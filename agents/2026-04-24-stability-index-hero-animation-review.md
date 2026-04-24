# Stability Index Hero Animation Review

Date: 2026-04-24
Scope: `/stability-index/` hero module, focused on `src/app/stability-index/presentational.tsx`, `src/app/stability-index/psi-lighthouse-scene.tsx`, and `src/app/stability-index/psi-lighthouse-scene.css`.

## Assumptions

- The goal is refinement guidance only, not implementation.
- The module should keep the Pharos lighthouse metaphor and existing dashboard density.
- Highest-return work means visible quality gains with limited architectural change.

## Evidence

- Local route checked at `http://localhost:3002/stability-index/`.
- Desktop captures:
  - `output/playwright/stability-index-hero-desktop.png`
  - `output/playwright/stability-index-scene-desktop.png`
  - `output/playwright/stability-index-scene-desktop-t35.png`
  - `output/playwright/stability-index-scene-desktop-t70.png`
- Mobile captures:
  - `output/playwright/stability-index-hero-mobile.png`
  - `output/playwright/stability-index-scene-mobile.png`
- Measured at `1280px`: document `scrollWidth` was `1328px`; the right hero column extended to `1327.94px`.
- Measured at `1024px`: document `scrollWidth` was still `1328px`; the card width was `756px` while the fixed scene stayed `480px` and the right column kept a `558.94px` intrinsic width.
- Measured at `1440px`: document `scrollWidth` returned to `1440px`.
- Reduced motion check: `getAnimations({ subtree: true })` returned `0` after `prefers-reduced-motion: reduce`.

## Verdict

The concept is strong and materially more distinctive than the previous arc-gauge treatment. The lighthouse reads as a lighthouse, the band color is integrated into the metaphor, and the reduced-motion path is healthy. The remaining highest-return work is mostly framing and motion orchestration, not more illustration detail.

## Highest-Return Findings

### 1. Breakpoint overflow is the largest shipping issue

`presentational.tsx:230-268` switches to the desktop two-column hero at `lg`, but the left scene is fixed at `lg:w-[30rem]` while the right column's KPI/stat/dimmer content has a much larger intrinsic width. At `1024px` and `1280px`, this creates horizontal document overflow and clips the right-side stats/dimmers.

Why it matters: this is not only polish. It breaks the hero at common laptop and tablet-landscape widths and makes the module feel unfinished.

Recommended fix:

- Keep the stacked layout until `xl`, or use a responsive grid that lets the scene shrink before forcing two columns.
- If keeping `lg`, change the scene wrapper from fixed `lg:w-[30rem]` to a bounded fluid width such as `lg:w-[min(42vw,30rem)]` plus `min-w-0` on the right column.
- Add `min-w-0` to the right flex column and consider hiding the row history stats until `xl`; the compact stats already exist.

### 2. `preserveAspectRatio="slice"` is cutting off the beam and weakening the scene

The approved spec called for `preserveAspectRatio="xMidYMid meet"`, but the current SVG uses `slice` in `psi-lighthouse-scene.tsx:252-258`. The live captures show the beam clipped at the left/top edges, especially on the scene-only screenshots. That makes the sweep look like a cropped triangle rather than a deliberate lighthouse beam.

Why it matters: the beam is the signature motion. If it is visibly sliced, the most memorable part of the hero feels accidental.

Recommended fix:

- Return to `meet`, or enlarge/rebalance the viewBox so `slice` has safe overscan.
- If the taller tower framing is desired, use explicit scene layout changes instead of `slice` cropping.
- Revisit the viewBox against the spec. The spec says `400 x 280`; current code is `280 x 240`, which leaves little lateral breathing room for a long beam.

### 3. Full 360-degree linear beam rotation is less professional than a constrained sweep

`psi-lighthouse-scene.css:32-58` rotates the beam `360deg` every `14s` with linear timing. Frame samples show the beam sliding from broad left sweep to a narrow top/right sliver. During parts of the cycle, the beam is mostly off-canvas or visually de-emphasized.

Why it matters: real lighthouse motion has intent and weight. A full spinner reads more like a rotating SVG primitive than a scanning beacon, and the scene loses its heroic composition for half the cycle.

Recommended fix:

- Replace the full spin with a constrained sweep, for example `-18deg -> 10deg -> -18deg`, using `cubic-bezier(0.45, 0, 0.2, 1)` or the repo motion token.
- Optionally add a second very subtle opacity pulse tied to the sweep apex.
- Keep the beam mostly in the upper-left composition so the page always preserves the intended hero read.

### 4. The beam origin and geometry make the light feel pasted behind the lantern

The beam starts at `LH_X, BEAM_Y` and rotates as a single group around that same point (`psi-lighthouse-scene.tsx:232-240`, `psi-lighthouse-scene.css:54-58`). Because the wedge begins exactly at the brazier point and the lighthouse is painted after it, the beam can feel like a large flat fan behind the tower rather than light emitted from inside the lantern room.

Why it matters: this is the difference between "nice SVG" and "premium illustration." The eye notices when light does not feel optically connected to its source.

Recommended fix:

- Add a narrow lantern-glass core or masked aperture in the colonnade, then start the beam slightly behind that aperture.
- Use a small bright core wedge plus wider atmospheric falloff, with the core clipped by the lantern room.
- Let the halo sit partially behind the lantern rails but keep a small foreground flame/core above them.

### 5. The scene is close to over-dominating the data at desktop

At 1440px the illustration is large and memorable, which is good, but the fixed `30rem` scene plus enlarged score makes the right-side data crowded. At 1280px this turns into actual overflow.

Why it matters: Pharos should stay data-dense and practitioner-facing. The hero can be distinctive, but the market state should still scan immediately.

Recommended fix:

- Shrink the scene slightly at `lg-xl`, then let it reach `30rem` only at wider widths.
- Keep the score block visually primary on the right by reducing the illustration's vertical dominance or adding a stronger alignment axis between the lantern center and score baseline.
- Consider moving the 30-day stats into a tighter 3-column strip under the score at `lg`, reserving the row layout for `xl+`.

## Secondary Polish

- `transitionStyle` uses plain `ease-out` in `psi-lighthouse-scene.tsx:249`; switch to a named project motion token or an exponential/quartic curve for smoother band changes.
- The halo pulse is healthy but a little generic. Use a lower amplitude and longer easing so it reads as atmospheric glow, not UI pulse.
- The star field is static and sparse. Slight parallax is unnecessary, but small opacity variation between stars would make the scene feel less flat.
- The waterline is useful but visually mechanical. A second low-opacity wave line with slower motion could make the bottom of the scene feel less like a chart grid, as long as reduced motion remains respected.
- The mobile top fold spends substantial vertical space before the hero. The scene itself behaves correctly on mobile, but the module begins low in the viewport. This is broader page composition, not only the hero module.

## What Is Working

- The Pharos metaphor is now explicit and memorable.
- The tower architecture is much stronger than the old icon treatment.
- Band color is used semantically: beam, flame, halo, and atmospheric wash.
- The reduced-motion path disables animation cleanly.
- The concept avoids generic SaaS card-grid sameness and fits the brand direction.

## Suggested Order

1. Fix responsive overflow.
2. Restore safe scene framing (`meet` or larger viewBox).
3. Replace the full-spin beam with a constrained sweep.
4. Improve beam-source optics around the lantern room.
5. Tune secondary atmosphere only after the first four are stable.
