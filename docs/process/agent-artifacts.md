# Agent Artifacts

Guidance for where agent-produced material belongs now that historical planning artifacts are no longer kept in a dedicated repository archive.

## Source Of Truth

Application source-of-truth documentation lives in `/docs/` and `README.md`. Put durable maintenance guidance in the closest existing verified doc, or create a focused page under `/docs/` when the guidance is repeatable and worth preserving.

Historical plans, one-off audits, exploratory research, point-in-time calibration reports, screenshots, and handoff notes are not product documentation. Keep them in the ignored `/agents/` scratch area unless the user explicitly asks to preserve them. If a historical note becomes useful long term, distill the durable rule or decision into `/docs/` rather than carrying the full artifact forward.

## Where To Put Durable Material

| Material                                        | Destination                                                    |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Repeatable process guidance                     | `docs/process/`                                                |
| Route-specific maintenance guidance             | Route doc or a dedicated subdirectory under `docs/`            |
| Operator remediation procedure                  | `docs/runbooks/`                                               |
| Product, API, pipeline, or methodology behavior | Existing feature/methodology doc plus timeline when applicable |

## Cleanup Rule

Before deleting a historical artifact, check whether any verified doc, test, source comment, or user-facing changelog still references it. Migrate only the durable content needed by current maintainers, then update the reference to the new `/docs/` page or remove it if the note was historical context only.

Do not create new committed planning-archive or calibration-snapshot material. Temporary investigation output should stay local, untracked, or in `/agents/`. Reviewed methodology decisions belong in the owning feature document and its timeline; the evidence report remains scratch output.

## Agent Skills

Project-local skill directories should contain Pharos-specific workflows only. Keep generic design, browser, vendor, or personal workflow skills in the user's global agent config instead of this repository.

The shared Pharos convention:

- `.codex/skills/<name>/SKILL.md` is the editable canonical source.
- `.agents/skills` is a directory symlink to `.codex/skills`, providing standard project-skill discovery without duplicating bodies.
- `.claude/skills/<name>/SKILL.md` is a relative symlink to `../../../.codex/skills/<name>/SKILL.md`.
- Canonical shared skill bodies must use repo-relative paths such as `.codex/skills/<name>/references/...` or normal repo source paths. Do not use `$CODEX_HOME` paths in a skill that Claude symlinks.

Every Pharos skill is canonical in `.codex/skills/` with matching `.claude/skills/<name>/` symlinks; there are no runtime-exclusive skills. The directory listing is the source of truth — do not maintain a name roster here. When a canonical skill has companion files the body reads (for example `reference.md`), symlink those alongside `SKILL.md`.

Skill bodies must not hard-code snapshots of current repo state (counts, methodology versions, enum lists, skill rosters). State the rule and point at the owning source file instead; when an enumeration is embedded for reading convenience, mark it with "the source file wins" so agents re-verify before relying on it.

`npm run check:agent-skill-symlinks` validates the `.agents/skills` alias and every Claude skill mirror. It also rejects waivers for symlinks that no longer exist and requires external-target waivers to carry `owner`, `reason`, and `reviewAfter` metadata. Symlinks that point outside this repository must be listed in `scripts/lib/agent-skill-symlink-waivers.json`.

## Claude Workflow Orchestrators

Checked-in `.claude/workflows/*.mjs` files are saved Claude orchestration entrypoints, not product runtime code and not Codex skills. Keep only repeatable Pharos-specific workflows here.

The workflow directory is the source of truth; do not maintain a second filename roster here. Keep orchestration only when it is repeatable, delegates meaningful parallel work, and is not already expressed by a skill or deterministic script. Workflows must resolve repo paths dynamically, accept volatile dates or scope as arguments, and read schemas/enums from their owning source files.

Documentation verification and remediation share one workflow with a mode argument. Static-data and compliance review remain separate because their source sets and adjudication rules differ. One-off broad reviews and generic model-verification harnesses belong in ignored scratch space or global tooling, not in the repository.

Generated reports from these workflows should stay under ignored scratch paths such as `/agents/` unless their durable rules are distilled into `/docs/`.

## Recurring Maintenance

`.github/workflows/agent-maintenance-candidates.yml` runs the deterministic annotation queue, AI-summary staleness queue, and curation digest each Monday. It opens or updates one review issue with bounded excerpts. The workflow is advisory: it does not edit stablecoin data, summaries, annotations, funding records, or review provenance.

Pre-launch and funding research remain deliberate operator workflows because they require current external-source verification and explicit approval. Candidate producers should automate discovery and triage, not editorial or financial decisions.

## Plugins And MCP

Pharos currently has no repository-owned plugin or MCP server. Keep it that way until the repository needs a shareable bundle or a live external integration that skills and scripts cannot provide. Saved workflows must not load tools from a user's plugin-cache path; installed global plugins are optional capabilities, not project dependencies.

## Local Hook Setup

Tracked hooks are intentionally limited to deterministic Git policy under `.githooks/` and stateless Claude hook configuration in `.claude/settings.json`. Codex executable hooks remain an explicit local opt-in because they can run shell commands outside normal tool approval:

```bash
PHAROS_INSTALL_CODEX_HOOKS=1 npm run agent:setup
npm run agent:doctor
```

The setup command writes ignored `.codex/hooks.json`; it never changes global configuration. The doctor checks skill discovery, workflow portability, hook installation, and stale local overrides without mutating the checkout.
