# Agents Archive Guide

`/agents` stores working artifacts produced during audits, investigations, implementation planning, design work, research, and execution tracking. Treat it as an agent collaboration surface and archive, not as the canonical source of product truth. Live code and the verified docs in `/docs/` win if anything here drifts.

## Core Rules

- Prefer the category folders below over creating new top-level folders.
- Use date-prefixed filenames for point-in-time artifacts: `YYYY-MM-DD-topic.md`.
- Keep filenames specific to the workstream: `2026-03-24-live-reserve-sync-audit.md`, not `notes.md`.
- If a document becomes normative product/process guidance, migrate the final truth into `/docs/` and leave `/agents/` as supporting context.
- When a folder already exists for a work type, add to it instead of scattering similar files at the root.

## Quick Routing

Put new files here:

- Audit or code review: `/agents/audits/`
- Implementation or remediation plan: `/agents/plans/`
- Open-ended investigation or incident analysis: `/agents/investigations/`
- Exploratory research or source survey: `/agents/research/`
- Design exploration or polish plan: `/agents/design/`
- Spec or design doc for a concrete feature: `/agents/specs/`
- Repeatable operating procedure: `/agents/process/`
- Tracker or execution board: `/agents/tasks/`
- Retrospective or postmortem: `/agents/retrospectives/`
- Small helper scripts used only by agent workflows: `/agents/scripts/`

## Naming Rules

Use date-prefixed filenames for point-in-time artifacts:

- `YYYY-MM-DD-topic.md`

Exceptions:

- `README.md` files
- evergreen process docs in `/agents/process/`
- long-lived trackers in `/agents/tasks/`
- reusable templates in `/agents/plans/templates/`
- established summary docs in `/agents/design/`

## Folder Guide

### `/audits/`

Agent-produced audit reports, review documents, and forensic writeups. Use this for broad system audits, subsystem reviews, or critique reports.

### `/plans/`

Active design, remediation, and implementation plans. If the plan is no longer active but still worth keeping, move it to `/plans/historical/`.

### `/plans/historical/`

Archived plans and old execution handovers. These may be stale and should never override current code or `/docs/`.

### `/plans/templates/`

Reusable plan templates or structured planning scaffolds.

### `/investigations/`

Focused incident analysis, production debugging notes, stale-data investigations, and root-cause hunts. Use this when the work is narrower than an audit and more forensic than general research.

### `/research/`

Research reports, source surveys, option comparisons, and background exploration that are not formal audits.

### `/design/`

UI/UX or presentation-oriented planning and summaries. Keep visual polish plans, design review notes, and final design execution summaries here.

### `/specs/`

Feature specs and design proposals for concrete implementation work. Use this when the output is a design contract rather than an execution plan.

### `/tasks/`

Pending trackers, execution boards, and running checklists. Move completed trackers to `/tasks/done/`.

### `/tasks/done/`

Completed trackers retained for reference.

### `/process/`

Recurring, standardized, or evergreen agent procedures. This is the right home for “how we do X in this repo” guidance.

### `/retrospectives/`

Retrospectives, lessons learned, and postmortems after substantial workstreams.

### `/scripts/`

Small scripts that support agent investigations or one-off workflow tooling. Do not put application runtime code here.

## Legacy and Special Cases

Some older work is stored in dated top-level folders such as `/agents/cron-live-audit-2026-03-23/`. Treat those as self-contained historical bundles. Do not copy that pattern for new work unless the user explicitly wants a dedicated bundle directory with multiple related artifacts.

Root-level files inside `/agents/` should stay rare. In practice, the only root file most agents should create is this `README.md`.
