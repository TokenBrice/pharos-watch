# Exit Route Map Impeccable Audit

Date: 2026-04-24

## Anti-Patterns Verdict

Pass with reservations. The current module no longer reads as a decorative AI-generated canal scene, but the pre-audit implementation still carried two quality tells:

- stale "canal" class/file naming after the visual concept changed to an instrument;
- SVG labels depended on ideal-length route names, so longer venue or chain labels could collide with the data bars.

The surface is now directionally aligned with Pharos: dense, precise, analytical, and data-shaped rather than ornamental.

## Findings

### Medium: stale component naming

- Location: `src/components/liquidity-stats.tsx`, `src/components/exit-route-canal.css`
- Category: Normalization
- Impact: The implementation contract still said "canal" while the UI had become an exit-route instrument. That mismatch makes future maintenance more error-prone and invites scenic regressions.
- Recommendation: Use `/normalize` to align the file/class naming with the current design concept.
- Resolution: Renamed the stylesheet/import/class contract to `exit-route-instrument`.

### Medium: fragile SVG label overflow

- Location: protocol and chain labels in `ExitRouteInstrumentScene`
- Category: Hardening
- Impact: Current production labels fit, but longer future protocols or chain names could overlap bars, logos, or adjacent lanes.
- Recommendation: Use `/harden` to compact visual labels while preserving full accessible labels and `<title>` text.
- Resolution: Added compact visual labels with full values retained in `aria-label` and `title`.

### Low: mobile overflow behavior needed explicit containment

- Location: SVG viewport wrapper
- Category: Responsive
- Impact: Horizontal scrolling is acceptable for this dense instrument, but the scroll container should contain inline overscroll and avoid implying page-level overflow.
- Recommendation: Use `/adapt` and `/polish` to scope overflow to the instrument viewport.
- Resolution: Added an explicit instrument viewport class with inline overscroll containment.

## Positive Findings

- The data seam remains correct: no liquidity API, scoring, methodology, or D1 changes.
- The SVG has a single image-level accessible summary and route-level labels with exact TVL/share values.
- Motion is limited to opacity and respects `prefers-reduced-motion`.
- The metric rail preserves exact HHI, route count, pool balance, organic share, and source caveat.

## Final Commands Applied

- `/normalize`: renamed the CSS/class contract from canal to instrument.
- `/harden`: compacted visual labels while retaining full accessible route names.
- `/adapt`: scoped horizontal overflow to the SVG viewport.
- `/polish`: kept the final pass focused on alignment, naming, and resilience.
