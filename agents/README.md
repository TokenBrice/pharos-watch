# Agents Archive Guide

`/agents` stores working artifacts produced during audits, implementation planning, research, and execution tracking. Treat this folder as an archive and collaboration surface, not as the canonical source of product truth. Live code and the verified application docs in `/docs/` win if anything here drifts.

## Naming Rules

Use date-prefixed filenames (`YYYY-MM-DD-topic.md`) for point-in-time artifacts such as audits, plans, research snapshots, execution reports, and retrospectives.

Exceptions:

- `README.md` files
- evergreen process docs in `/agents/process/`
- long-lived trackers in `/agents/tasks/`
- reusable templates in `/agents/plans/templates/`

## Structure

### `/audits/`

Agent-produced audit reports and forensic writeups.

### `/plans/`

Active design and implementation plans. Once implemented or superseded, move them to `/plans/historical/`.

### `/plans/historical/`

Archived plans and execution handovers. These documents can contain stale instructions and should never override live code or `/docs/`.

### `/plans/templates/`

Reusable plan and ticket templates.

### `/research/`

Research reports that are not audits.

### `/tasks/`

Pending trackers and execution boards. Move completed trackers to `/tasks/done/`.

### `/tasks/done/`

Completed trackers kept for reference.

### `/process/`

Recurring and standardized processes.

### `/retrospectives/`

Workflow retrospectives and postmortems.
