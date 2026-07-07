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

Project-local skill directories should contain Pharos-specific workflows only. Keep generic design, browser, vendor, or personal workflow skills in the user's global agent config instead of this repository.

The shared Pharos convention:

- `.codex/skills/<name>/SKILL.md` is canonical for workflows that must exist on both Codex and Claude.
- `.claude/skills/<name>/SKILL.md` is a relative symlink to `../../../.codex/skills/<name>/SKILL.md`.
- Canonical shared skill bodies must use repo-relative paths such as `.codex/skills/<name>/references/...` or normal repo source paths. Do not use `$CODEX_HOME` paths in a skill that Claude symlinks.

Every Pharos skill is canonical in `.codex/skills/` with matching `.claude/skills/<name>/` symlinks; there are no runtime-exclusive skills. The directory listing is the source of truth — do not maintain a name roster here. When a canonical skill has companion files the body reads (for example `reference.md`), symlink those alongside `SKILL.md`.

Skill bodies must not hard-code snapshots of current repo state (counts, methodology versions, enum lists, skill rosters). State the rule and point at the owning source file instead; when an enumeration is embedded for reading convenience, mark it with "the source file wins" so agents re-verify before relying on it.

`npm run check:agent-skill-symlinks` validates that skill symlinks are not broken, rejects waivers for symlinks that no longer exist, and requires external-target waivers to carry `owner`, `reason`, and `reviewAfter` metadata. Symlinks that point outside this repository must be listed in `scripts/lib/agent-skill-symlink-waivers.json`.

## Claude Workflow Orchestrators

Checked-in `.claude/workflows/*.mjs` files are saved Claude orchestration entrypoints, not product runtime code and not Codex skills. Keep only repeatable Pharos-specific workflows here.

Current saved workflows:

- `adverse-data-review` — verify static stablecoin metadata across tracked coins and retain only high-confidence wrong values.
- `compliance-research` — broad MiCA + GENIUS compliance research and verification pass.
- `code-health-broad` — broad code-health review pipeline that fans out domain finders, verifies findings, clusters them, and writes an `agents/code-health-report.md` scratch report.
- `mixed-verify` — reusable mixed-model verification harness for static-data checks, audits, and reviews.
- `docs-verify` — verify the whole `/docs` corpus against actual code and adjudicate doc-vs-code discrepancies.
- `docs-verify-remediate` — apply the adjudicated doc-vs-code fixes from `findings.json`, one agent per doc.
- `docs-audit` — change-aware full-corpus docs-vs-code audit: verify every doc, opus-tier the docs owning the last 24h of code changes, adversarially adjudicate, and synthesize.

Generated reports from these workflows should stay under ignored scratch paths such as `/agents/` unless their durable rules are distilled into `/docs/`.
