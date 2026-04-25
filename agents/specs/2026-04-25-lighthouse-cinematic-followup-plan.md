# Lighthouse Cinematic Follow-Up Plan

Date: 2026-04-25
Status: Follow-up plan to execute only after the base cinematic engine in `agents/specs/2026-04-25-lighthouse-cinematic-engine-plan.md` is implemented and reviewed.
Scope: Identify and execute further enhancement opportunities for `/lighthouse/` after the base textless cinematic route is live locally.

## Preconditions

- The base plan has been implemented.
- `/lighthouse/` no longer uses the standard visible `FeaturePageShell` chrome.
- The page renders a single cinematic SVG stage with a central lighthouse, chain fleet, DEWS radar layer, and alt-peg projection.
- Base tests, doc checks, build, and local visual screenshots have passed.
- A base implementation review has confirmed that the scene does not overclaim data semantics.

## Follow-Up Objective

Use the implemented base route as a working object, not a mock. Review the cinematic experience in the browser, identify the highest-value refinements, implement the ones that are bounded and clearly improve the page, then run a specialized review pass across design, data semantics, accessibility, performance, and test coverage.

## Enhancement Areas To Inspect

### 1. Cinematic Composition

- Whether the lighthouse is unmistakably the center of the scene.
- Whether the harbor fleet, radar field, and alt-peg projection read as one scene instead of separate overlays.
- Whether first paint has visual depth without feeling like a card or dashboard panel.
- Whether the stage has enough negative space for the beam and radar to breathe.
- Whether mobile composition preserves the lighthouse-first identity.

Candidate refinements:

- Adjust stage coordinates and layer opacity.
- Add foreground rock/water silhouettes to anchor the tower.
- Tune beam cone shape and target alignment.
- Add mode-specific dimming so radar/atlas modes clarify focus without text.

### 2. Motion Quality

- Whether the beam, lens, radar, wakes, water, and projection move with purpose.
- Whether the animation density is calm by default and urgent only when data is urgent.
- Whether mode transitions are legible and not distracting.
- Whether reduced-motion mode is fully static and still useful.

Candidate refinements:

- Tune animation durations and easing.
- Add staggered first-load reveal if it improves orientation.
- Add subtle mode transitions between watch, radar, and atlas.
- Reduce or remove any motion that reads as decorative noise.

### 3. Interaction And Discovery

- Whether icon-only controls are discoverable without adding permanent prose.
- Whether hover/focus/selection states make the beam relationship obvious.
- Whether coarse-pointer behavior avoids accidental navigation.
- Whether a selected harbor remains understandable when labels are hidden.

Candidate refinements:

- Add stronger focus and selected states.
- Add a deliberate, optional ledger reveal control.
- Improve icon tooltips or accessible labels.
- Add direct links only after explicit selection.

### 4. Data Semantics

- Whether all visible marks map to existing fields.
- Whether DEWS remains aggregate market weather and never chain-specific.
- Whether PSI remains the lens/beam condition and not a new route score.
- Whether alt-pegs remain a peg diversity projection and not chain/safety data.
- Whether fallback text gives exact values without overclaiming.

Candidate refinements:

- Adjust visual grouping to separate aggregate DEWS from chain ships.
- Add or tighten route-doc caveats.
- Simplify any visual channel that risks mixed semantics.

### 5. Accessibility And Responsive Parity

- Whether the SVG has a useful atomic `aria-label`.
- Whether primary marks have keyboard parity.
- Whether the compact fallback ledger contains the same core facts as the scene.
- Whether text overflow and tap targets are safe on mobile.
- Whether the page remains usable with data errors or partial query failures.

Candidate refinements:

- Improve fallback ledger grouping.
- Add test coverage for mode controls, keyboard selection, and missing data.
- Increase coarse-pointer hit areas.
- Tighten loading and partial-data states.

### 6. Performance And Maintainability

- Whether the stage is SVG-only and avoids JS animation loops.
- Whether the new route files are readable and not over-abstracted.
- Whether shared helpers are reused without risky `/chains/` regressions.
- Whether the route adds avoidable bundle weight.

Candidate refinements:

- Remove unused old lighthouse story files.
- Consolidate repeated geometry only after the route stabilizes.
- Cap dense marks more aggressively if rendering is heavy.
- Add focused tests instead of snapshot coverage.

## Execution Plan

1. **Browser audit**
   - Run the local app.
   - Capture desktop, tablet, mobile, and reduced-motion screenshots.
   - Record concrete issues in `agents/retrospectives/2026-04-25-lighthouse-cinematic-implementation-notes.md`.

2. **Triage**
   - Classify each issue as base blocker, follow-up enhancement, or reject.
   - Only implement follow-ups that are bounded and improve the cinematic experience without adding new data semantics.

3. **Implementation**
   - Make one or more focused follow-up commits.
   - Keep refinements small enough to review visually.
   - Update docs/tests only where behavior changes.

4. **Specialized review**
   - Spawn independent specialized reviewers after follow-up implementation:
     - Design/cinematic reviewer.
     - Data semantics reviewer.
     - Accessibility/responsive reviewer.
     - Test/performance reviewer.
   - Treat actionable findings as a final remediation pass before declaring the whole route complete.

5. **Final validation**
   - Re-run targeted tests.
   - Re-run relevant doc checks.
   - Re-run build or merge gate as appropriate for the changed surface.
   - Capture final screenshots.

## Non-Goals

- Do not add a new route score.
- Do not add per-chain DEWS attribution.
- Do not add new APIs, D1 tables, cron jobs, or data providers.
- Do not promote `/lighthouse/` to primary navigation unless explicitly requested.
- Do not turn the route back into a visible prose story or dashboard card layout.
