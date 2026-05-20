# Agent Artifacts

Guidance for where agent-produced material belongs now that historical planning artifacts are no longer kept in a dedicated repository archive.

## Source Of Truth

Application source-of-truth documentation lives in `/docs/` and `README.md`. Put durable maintenance guidance in the closest existing verified doc, or create a focused page under `/docs/` when the guidance is repeatable and worth preserving.

Historical plans, one-off audits, exploratory research, screenshots, and handoff notes are not product documentation. Keep them out of the repository unless the user explicitly asks to preserve them. If a historical note becomes useful long term, distill the durable rule or decision into `/docs/` rather than carrying the full artifact forward.

## Where To Put Durable Material

| Material | Destination |
| --- | --- |
| Repeatable process guidance | `docs/process/` |
| Route-specific maintenance guidance | Route doc or a dedicated subdirectory under `docs/` |
| Operator remediation procedure | `docs/runbooks/` |
| Product, API, pipeline, or methodology behavior | Existing feature/methodology doc plus timeline when applicable |
| Generated code-discovery map | `docs/agent-code-map.md` |

## Cleanup Rule

Before deleting a historical artifact, check whether any verified doc, test, source comment, or user-facing changelog still references it. Migrate only the durable content needed by current maintainers, then update the reference to the new `/docs/` page or remove it if the note was historical context only.

Do not create new committed planning-archive material. Temporary investigation output should stay local, untracked, or in an explicitly ignored scratch location.

## Agent Skills (`.claude/skills/` vs `.codex/skills/`)

Both Claude Code and OpenAI Codex load skills from their own per-tool directory (`.claude/skills/<name>/` and `.codex/skills/<name>/`). Nine skills are duplicated across both surfaces and have historically drifted.

The reconciliation convention:

- **Byte-identical pairs** (currently `annotations-refresh`, `stablecoin-addition-orchestrator`, `stablecoin-runtime-price-marketcap-gate`): the `.claude/skills/<name>/SKILL.md` file is a relative symlink to `../../../.codex/skills/<name>/SKILL.md`. Edit the codex copy; both surfaces pick up the change automatically.
- **Asymmetric pairs** (currently `coingecko-id-verif`, `contract-enrich`, `contract-populate`, `reserve-research`, `resilience-classify`, `stablecoin-info-fetch`): kept as independent files. Most claude-side copies ship a monolithic `SKILL.md` with all mappings, scripts, and references inlined; `coingecko-id-verif` is the current exception and keeps its Claude manifest at `.claude/skills/coingecko-id-verif/skill.md` next to `.claude/skills/coingecko-id-verif/verify.py`. The codex-side ships a slim `SKILL.md` plus `agents/openai.yaml`, `references/*.md`, and `scripts/*` that resolve via `$CODEX_HOME/...` paths. Cross-symlinking would break runtime path semantics in one direction and strip authoritative inline content in the other. When updating one of these skills, mirror the substantive change in the other; do not assume one side is canonical.

When adding a new skill that needs to live on both surfaces, prefer authoring it codex-style (slim SKILL.md + supporting subdirectories) and symlinking the claude SKILL.md to the codex one. If a Claude agent needs inline content because it cannot resolve external references, keep the two files separate and call out the convention here.
