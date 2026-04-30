# Agent Artifacts

Guidance for where agent-produced material belongs now that historical planning artifacts are no longer kept in a dedicated repository archive.

## Source Of Truth

Application source-of-truth documentation lives in `/docs/` and `README.md`. Put durable maintenance guidance in the closest existing verified doc, or create a focused page under `/docs/` when the guidance is repeatable and worth preserving.

Historical plans, one-off audits, exploratory research, screenshots, and handoff notes are not product documentation. Keep them out of the repository unless the user explicitly asks to preserve them. If a historical note becomes useful long term, distill the durable rule or decision into `/docs/` rather than carrying the full artifact forward.

## Where To Put Durable Material

| Material | Destination |
| --- | --- |
| Repeatable process guidance | `docs/process/` |
| Long-lived execution tracker | `docs/trackers/` |
| Route-specific maintenance guidance | Route doc or a dedicated subdirectory under `docs/` |
| Operator remediation procedure | `docs/runbooks/` |
| Product, API, pipeline, or methodology behavior | Existing feature/methodology doc plus timeline when applicable |
| Generated code-discovery map | `docs/agent-code-map.md` |

## Cleanup Rule

Before deleting a historical artifact, check whether any verified doc, test, source comment, or user-facing changelog still references it. Migrate only the durable content needed by current maintainers, then update the reference to the new `/docs/` page or remove it if the note was historical context only.

Do not create new committed planning-archive material. Temporary investigation output should stay local, untracked, or in an explicitly ignored scratch location.
