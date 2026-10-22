# Agent Artifacts

## Source Of Truth

`docs/` and `README.md` are the verified documentation corpus. Keep historical plans, audits, calibration reports, screenshots and handoffs in ignored `agents/` unless explicitly asked to preserve them. Distill reusable truth into the closest verified owner, not a committed planning archive.

## Where To Put Durable Material

Use existing feature/route docs for behavior, structured methodology changelogs for version history, `docs/process/` for repeatable policy and `docs/runbooks/` for remediation. Architectural constraints follow [ADR admission](#architectural-decisions).

## Architectural decisions

- **Admission:** cross-domain constraints or changes to write authority, interface meaning or authoritative runtime. Domain rulings, versions, release targets, incident telemetry, per-application notes and deploy steps belong in their owners, not ADRs.
- **Identity/approval:** next ID is highest existing `#### ADR-N` + 1; never reuse absent IDs 11–18 or renumber records. Maintainer merge to protected main is approval. Add/amend/supersede only when asked; call ADR changes out separately in commit body/PR.
- **Amendment:** clarify scope/enforcement or correct falsified clauses in place. True reversals retain a tombstone and reciprocal `supersedes` / `superseded by` lines; a falsified premise also gets `premise falsified by ADR-N` on the earlier record in the same change.
- **Format/evidence:** leave headings status-free for stable anchors. After a blank line, use one metadata line with non-default segments: `**Status:** … · **Relations:** … · **Enforcement:** … · **Evidence:** … · **Acceptance:** …`. Evidence is a verified doc or commit SHA, never scratch alone; missing approval is `approval record unavailable`. The shipper records production acceptance as pending/accepted/failed with evidence; unknown stays `not recorded`.
- **Co-updates:** quick-nav, reciprocal relations, owning doc and `docs/doc-ownership.json` ADR background anchors for governed sources move together. Root guidance changes only for a changed hard rule. For cron ceilings, alias/accounting-only changes adding no work/fetch/connection pressure get a dated `CRON_GROWTH_HEADROOM_POLICY` note; other crossings follow the [growth gate](./cron-trigger-policy.md#current-growth-gate).

## Cleanup Rule

Before deleting an artifact, find references in verified docs, tests, source comments and user-facing changelogs. Migrate needed durable content and retarget/remove those references. Do not commit new planning archives or calibration snapshots; reviewed methodology belongs in its owner and structured changelog, evidence in scratch. Ignored files are not automatically disposable.

**Clean up after yourself.** Before reporting a task done, the agent that created scratch deletes its own bulky intermediates: replay and capture JSON, D1/SQLite copies, heap snapshots, large logs, copied checkouts and `worktree-files`, and its own git worktrees (`git worktree remove`). Keep only the closure summary and the small evidence an open gate or `ops:followup` issue still names; if a large file must outlive the task, say so in the summary with its safe-to-remove condition. This authority covers only files you created in this task, never another agent's or session's scratch.

## Campaign Index And Handoff

Bounded fixes/reviews need authorized implementation, focused validation and a concise outcome, not a scratch directory or ledger. For substantial cross-session/coordinated work, use `agents/<YYYY-MM-DD>-<slug>/` and leave a discoverable closure summary: goal/invariants, owner, current status, source/plan authority, every task's complete/deferred/superseded/blocked outcome with reason, actual changed files, exercised checks and CI/deploy/operational evidence, durable destinations, next action/owner and retention (review date/event plus safe-to-remove condition and required owner confirmation).

A campaign README, per-artifact rows (path/kind/owner/status/dates/source/destination/retention), task ledgers, dispatch packets and `outputs/`/`evidence/` folders are optional tools, not required templates. Use them only when they improve handoff; record exact scope, exclusions, dependencies and acceptance where a delegate needs them. Reconcile every existing task ID, including deferred/superseded work. Retain useful evidence through its recorded gate; never infer deletion authority from age or ignore status.

### Follow-up issues

Open loops that outlive scratch go in GitHub issues, which are public: write them as if published, with no row-level D1 data, chat IDs, partner or commercial detail, security gaps (use a private advisory) or credentials. Labels: `ops:followup` (a dated or event-gated check), `ops:decision` (blocked on an owner call), `ops:campaign` (tracking issue for multi-PR work); plain defects keep `bug`. Use a milestone only when a campaign spans several PRs. The body must stand alone after `agents/` is cleaned:

```
Due: YYYY-MM-DD          (optional; read by .github/workflows/ops-followups.yml)
Origin: PR #N / commit / ADR-N
Check: exact query, command or URL that answers it
Done when: closing condition
Evidence: agents/<path> (local, may be gone)
```

Close with the PR (`Closes #N`) or a comment naming the evidence; distill durable truth into its owning doc first. Do not duplicate CI-failure issues or user intake.

## Pinned On-Chain Evidence

Use `npm run research:dwellir-rpc -- --help` for CLI/methods/auth. `USAGE` and `assertPinnedCapability` in `scripts/maintenance/dwellir-rpc.mjs` own the interface/safety gates; `scripts/lib/pinned-rpc-providers.mjs` owns provider resolution. Save evidence in ignored `agents/`. Research registrations never change runtime provider priority, archive eligibility or log-history declarations.

- **Pins:** require explicit matching numeric/hash pins, never symbolic/latest substitution. Log ranges need numeric bounds ending at the pin or matching `blockHash`. Move pins are ledger versions, not heights; Solana slots, Sui checkpoints and Hedera mirror blocks retain native identity/time (including nanosecond consensus time). Headers before/after must agree; every EVM block result, standalone or batched, must match that header's number/hash/time. Non-null transaction results require the requested 32-byte identity (`receipt.transactionHash` or `transaction.hash`, case-insensitively) and pinned block membership; invalid identities are withheld, never rewritten. Null transactions remain empty, not absence proof. A nearby header cannot pin current state. A pin identifies a read, not independent provider-parity proof.
- **Simulation:** EVM `eth_call` state overrides retain `simulation: true` on affected records/batch members: hypothetical execution against pinned base state, never observed balances, supply, authority or a real redemption receipt. Transport support does not promise override support; provider rejection withholds results.
- **Failure/security:** no automatic provider fallback; only result-cap subdivision retries. Failed/unsupported reads have null results, never synthetic zero/empty lists; any failed chunk/batch member withholds the whole result. Failed HTTP responses admit no result. URLs stay keyless, echoes redacted, redirects rejected; never transfer credentials to another provider or put them in URLs/arguments.
- **Provenance:** cite keyless URL, effective method/params, native pin/block/hash/timestamp and `observedAt`; retain range/chunk diagnostics and Sui query/variables. Decimal strings preserve integer precision. Non-ok records name a machine-readable reason; `empty` logs/accounts/transactions never prove absence or census completeness. Output-write failure is not persisted evidence.
- **Entitlement:** endpoint registration/public reachability, range caps and completed chunks do not establish service availability, paid-plan entitlement, archive retention or completeness; public hosts do not verify paid network aliases. Pruned/unavailable history fails closed, never falls back to latest. Filecoin EVM headers do not certify archived Lotus metadata or TipSet/parent-state parity. TRON current/solidified simulation is unsupported pinned state until a pin-capable API exists.
- **Solana execution:** finalized produced-slot enumeration plus every returned block in full is needed for a census; pruned/missing blocks or unsupported transaction versions are errors. Account samples do not certify address/program execution completeness.
- **Solana accounts:** Alchemy paid Account Archive requires entitlement and exact account coverage (starts July 2025), exact `slot` and matching `context.slot`; vote and `Sysvar...` accounts are excluded. `minContextSlot`/history cursors are not historical snapshots; standard account/token/program APIs or current `getTokenSupply` are no substitute. Decode exact-slot bytes; identity/ABI and complete controller/execution evidence are still required to close a scoped gap. Null is not absence.
- **Sui:** public GraphQL state uses explicit `Checkpoint.query`; field-specific retention can be roughly one hour for live objects/balances. Old/pruned checkpoints fail closed; GraphQL errors withhold partial data. Legacy Dwellir JSON-RPC is execution-only, not historical object state; decommissioning never licenses latest fallback.

Production database diagnostics are separate: [Remote D1 inspection](../worker-infrastructure.md#remote-d1-inspection).

## Agent Skills

`.codex/skills/<name>/` is the canonical physical tree; `.agents/skills` points to it and `.claude/skills/<name>/` mirrors files/directories by relative symlinks. Only `agents/openai.yaml` display metadata is exempt; all other companions mirror. Keep repo skills Pharos-specific and use repo-relative paths, not `$CODEX_HOME`. No skill roster or volatile counts/versions/enums: link the owner (or mark an embedded enumeration “the source file wins”). Verify literal paths/claims against source; parity is structural proof, not semantic truth.

Run `npm run check:agent-skills` (in `check:structural`) for parity, links, frontmatter and rejection of physical facade copies. `node scripts/maintenance/sync-agent-skills.mjs --write` repairs facade symlinks and prunes deleted skills' wrappers containing only exact managed symlinks; physical contents/unmanaged entries are preserved. Fix canonical bodies only; broken/external symlinks are unsupported.

Use compact entries: Trigger And Exclusions; Classify The Operation; Mandatory Core (always-required anchors/hard stops); Branch Reads And Actions (conditional owner anchors); Checks Owned By The Verifier; Completion Evidence. Put reviewer/rehearsal details in linked companions. Writers hand checks to the verifier; parent owns integration. Link durable owners, not expired scratch task IDs. Release/CI skills link [Pre-push readiness](../testing.md#pre-push-readiness), not a local receipt mandate; keep protected-main authority, failed-leaf diagnosis, generated-artifact policy and deploy-versus-operational evidence explicit at the action, owned by their source contracts.

## Harness Configuration

Read tracked `.omp/config.yml` for the local overlay (isolation disabled, approval `yolo`); model roles are global, not a repo fleet. Claude uses `.claude/settings.json`; Codex has no project `config.toml` and hooks are [opt-in](#local-hook-setup). Discover effective session permissions and capabilities without copying personal config. Skills describe native delegation, web search, primary-source fetch, MCP and browser inspection by capability, not a harness-specific tool roster.

Use a bounded no-write contract for reviewers. Without delegation, perform discovery/skeptical reopening sequentially and disclose non-independence. Prior authorization remains valid for its stated cohort/action; ask only for uncovered scope or required row-specific approval. Unavailable tools permit the next safe read-only option, never inferred write/delegation authority or credential movement.

## Claude Workflow Orchestrators

Batch fan-out lives in canonical skills; compliance and documentation maintenance use their respective workflows. Retired adapters are not preserved.

## Recurring Maintenance

`.github/workflows/agent-maintenance-candidates.yml` produces advisory annotation/AI-summary/curation queues weekly with immutable 90-day artifacts; it never publishes or edits reviewed data. [Annotation review](../../.codex/skills/annotations-refresh/SKILL.md) owns source-window completeness, offline replay and explicit candidate-ID decisions. Preserve permanent editorial history, dispositions, deferrals, backups and snapshots; retain review file/queues/history together. Retention is a recovery window, not perpetual handoff storage; incomplete source windows cannot prove coverage. Pre-launch/funding research still needs current sources and explicit approval; discovery never grants editorial/financial authority.

## Plugins And MCP

No repo-owned plugin/MCP server is needed absent a shareable bundle or live integration that skills/scripts cannot provide. Global plugins are optional; saved workflows must not depend on personal plugin-cache paths.

## Local Hook Setup

Claude's stateless hooks live in `.claude/settings.json`. Codex executable hooks are per-checkout opt-in: review commands, then `PHAROS_INSTALL_CODEX_HOOKS=1 npm run agent:setup`. It writes ignored `.codex/hooks.json`, never global config. Setup reports installed/current configuration and recorded enablement, not actual invocation/managed overrides; inspect `/hooks` and make a safe active-harness call. Disabled/unrecorded state does not change installation success. `scripts/maintenance/setup-agent-hooks.ts` and `scripts/ci/pharos-change-contract.ts` own matchers and bounded policy checks, not an exhaustive shell sandbox. Git/workspace automation belongs to [Scripts](../scripts.md#operational-notes).

Shell continuations are joined outside single quotes, including inside double quotes; literal single-quoted backslashes/newlines stay intact. Heredocs retain their body and expansion mode and are associated with the receiving command: quoted/unquoted and `<<-` bodies feeding a recognized shell's stdin-script mode use the bounded nested-policy checks. A separate shell script filename or `-c` keeps stdin as data; later input redirections determine which heredoc feeds stdin. Node/data examples stay inert unless an unquoted body performs guarded command expansion.

Use explicit workdir for ambiguous shell cwd; path normalization includes symlink ancestors/move destinations. Literal shell-stdin scripts are inspected, dynamic guarded producers fail closed, quoted examples are inert; `command`/`cmd` payloads share policy. Diagnostics (`PHAROS_HOOK_DIAGNOSTICS=1` or `--diagnostics`) append safe JSONL to `agents/hook-diagnostics.jsonl` or `PHAROS_HOOK_DIAGNOSTICS_FILE`: timestamp, harness/event/tool, decision/rule, protected-path count and digest, never command text/secrets. Unsafe destinations are rejected; write failure never changes policy. Keep diagnostics off by default, local and bounded by purpose/end date; unset after investigation, retain needed evidence before rotation. Never enable globally, upload rows or require append success.
