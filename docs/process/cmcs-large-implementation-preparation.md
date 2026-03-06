# Preparing Large Implementations for cmcs Execution

This document defines the preparation process for large, multi-phase development projects that will be executed by Codex agents via cmcs. The goal is to produce a self-contained project folder that any fresh orchestrator session can pick up and execute without re-discovering the codebase.

## When to Use This Process

Use this for any task that meets **two or more** of:

- Touches more than 10 files
- Requires coordinated changes across frontend, worker, and/or database
- Has a deployment sequence that could break production if misordered
- Needs rollback procedures
- Will be split across multiple cmcs worktrees or sessions

Small tasks (single ticket, one worktree, no deployment risk) don't need this — just write a ticket and run it.

## Project Folder Structure

All artifacts live in `docs/plans/<project-name>/`:

```
docs/plans/<project-name>/
  <date>-<project-name>-design.md          # 1. Design document
  implementation-plan.md                    # 2. Implementation plan
  execution-handover.md                     # 3. Execution handover
  PROGRESS.md                              # 4. Progress tracker
  tickets/                                 # 5. Tickets
    phase1-<label>/
      TICKET-001.md
      TICKET-002.md
    phase2-<label>/
      TICKET-001.md
    ...
```

Supporting artifacts (mapping tables, migration SQL, research reports) may live in research worktrees or alongside the tickets — reference them explicitly from the handover document.

---

## Phase 0: Research

Before writing any design or plan, **understand the blast radius**. Spin up Codex research agents in isolated worktrees to answer specific questions about the codebase.

### What research agents produce

Each research worktree should output a `DESIGN-*.md` or `DESIGN-*.ts` artifact — a structured deliverable that feeds directly into the design document. Examples:

- `DESIGN-MAPPING-TABLE.ts` — a data structure mapping old values to new values
- `DESIGN-MIGRATION-DRAFT.sql` — a SQL migration script with placeholders
- `DESIGN-API-TRANSITION.md` — an inventory of API changes needed
- `DESIGN-FRONTEND-MIGRATION.md` — a file-by-file frontend change list
- `RESEARCH-REPORT.md` — raw codebase analysis (grep results, dependency graphs, edge cases)

### Research worktree pattern

```bash
cmcs worktree create research-<aspect>
# Write a ticket asking Codex to audit/inventory a specific area
# Output: a DESIGN-* artifact in the worktree root
```

Research worktrees are **read-only explorations** — they don't modify production code. They persist as reference material throughout the project.

### When to skip research

If you already have complete knowledge of the affected files and can enumerate every change needed, skip straight to the design document. Research is for unknowns.

---

## 1. Design Document

**File:** `<date>-<project-name>-design.md`

The design document answers **why** and **what** — high-level decisions that justify the implementation approach. It is the reference document when someone asks "why did we do it this way?"

### Required sections

| Section | Purpose |
|---------|---------|
| **Problem** | What's broken or missing. Why the current state is unacceptable. |
| **Goal** | One-paragraph target state. What success looks like. |
| **Format/Schema** | If introducing new data formats, types, or schemas — specify them precisely. Include collision resolution, edge cases, validation rules. |
| **Current Architecture** | Relevant parts of the current system. Data flow diagrams. Where the changes touch. |
| **Schema/Type Changes** | Exact interface diffs. New fields, changed fields, removed fields. |
| **Migration Strategy** | How to get from current state to target state without breaking production. |
| **API Changes** | Endpoint behavior changes, backward compatibility approach, transition periods. |
| **Frontend Changes** | Component inventory, URL changes, localStorage migration, SEO impact. |
| **Risks and Mitigations** | Table of risks with concrete mitigations — not vague "we'll be careful." |

### Guidelines

- Reference research artifacts by path (e.g., "Full mapping in `DESIGN-MAPPING-TABLE.ts`")
- Be specific: "18 files currently inline `/stablecoin/${id}`" not "several files construct URLs"
- Include code snippets for before/after patterns
- Every risk needs a concrete mitigation, not just acknowledgment

---

## 2. Implementation Plan

**File:** `implementation-plan.md`

The implementation plan answers **how** — the sequencing of work into phases, worktrees, and tickets. It is the structural skeleton that the execution handover builds on.

### Required sections

| Section | Purpose |
|---------|---------|
| **Execution Strategy** | Summary stats: N phases, M worktrees, K tickets. Sequential vs parallel. |
| **Phase breakdown** | One section per phase with: worktree name(s), ticket table (number, title, key files), dependency notes. |
| **Gate criteria** | What must pass before proceeding to the next phase. Always includes `npm run build && cd worker && npx tsc --noEmit && npm test`. |
| **Manual steps** | Any human-only steps (D1 migrations, secret rotation, DNS changes) called out explicitly with their position in the sequence. |
| **Worktree dispatch summary** | Quick-reference showing all worktrees and their create/run/wait commands. |
| **Supporting artifacts table** | Links to all DESIGN-* files and their locations. |

### Phase design principles

- **Phases are sequential gates.** Never start Phase N+1 until Phase N is merged and verified.
- **Worktrees within a phase run in parallel.** Design them to touch non-overlapping files.
- **Each phase should be independently deployable** and leave production in a working state. If a phase can't be deployed alone, it must be combined with the next phase into a single maintenance window.
- **Earlier phases are lower-risk.** Foundation/scaffolding first, then code migration, then the big switchover, then cleanup.
- **Cleanup phases have calendar gates** (e.g., "30 days after Phase 3"), not just technical gates.

### Ticket decomposition

Tickets are the atomic unit of work for Codex agents. They should be:

- **Narrowly focused** — one logical change per ticket. If a ticket touches more than 5 files for different reasons, split it.
- **Sequential within a worktree** when they have dependencies (TICKET-001 output is TICKET-002 input).
- **Self-contained** — a Codex agent should be able to complete the ticket without reading other tickets or the design document. Include all necessary context inline.

---

## 3. Execution Handover

**File:** `execution-handover.md`

The execution handover is the **operational runbook** for a fresh orchestrator session. It contains everything needed to execute the plan without re-reading the design or re-discovering the codebase. This is the document you read after context compaction.

### Required sections

| Section | Purpose |
|---------|---------|
| **What this does** | One paragraph summary of the entire project. |
| **File inventory** | Tree view of all project files — design, plan, handover, progress, tickets, research artifacts. |
| **Execution commands per phase** | Copy-paste shell blocks for: create worktree, copy tickets, run cmcs, wait. |
| **Review checklists per phase** | Runnable verification commands: build, tsc, test, plus grep-based spot checks specific to each phase's changes. |
| **Merge instructions** | Merge order for parallel worktrees, expected conflicts, `[skip ci]` requirements. |
| **Post-deploy smoke tests** | curl commands testing runtime behavior after each phase deploy. |
| **Rollback procedures per phase** | Exact commands to undo each phase. Include git revert, wrangler rollback, D1 Time Travel as applicable. |
| **Known risks and mitigations** | Full table — carried from design but expanded with operational details discovered during planning. |
| **Orchestrator protocol** | Step-by-step responsibilities: update progress, create worktrees, launch runs, review, merge, smoke test. |
| **When Codex fails** | Recovery procedure: check logs, identify failure, fix ticket or code, re-run. |
| **After context compaction** | Instructions for a fresh session: read PROGRESS.md first, then this file, pick up where progress says. |
| **Pre-flight checks** | What to verify before starting: cmcs initialized, clean working tree, research artifacts intact, main up to date. |

### Guidelines

- **Copy-paste ready.** Every command block should be runnable as-is — no "replace X with your value" unless truly variable.
- **Verification before merge.** Every phase has a review checklist with concrete grep/count checks, not just "review the diff."
- **Rollback at every level.** Each phase documents how to undo it. Rollback should be faster than the original operation.
- **Drift detection.** If the project spans multiple sessions, include commands to detect codebase drift (new entries added, files moved, etc.) between phases.

---

## 4. Progress Tracker

**File:** `PROGRESS.md`

The progress tracker is the **single source of truth** for project state. It's the first file a fresh session reads.

### Format

```markdown
# Project Progress Tracker

**Last updated:** <date> (update this line after every state change)

## Current State

**Active phase:** Phase N — <status>
**Next action:** <what to do next>

## Phase Checklist

### Phase 1: <Label>
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (N/M tickets, K failures)
- [x] Review checklist passed
- [x] Merged to main (commit <hash>)
- [x] Post-deploy smoke test passed
- [ ] Worktree cleaned up

### Phase 2: <Label>
- [ ] ...

## Incident Log

Record any failures, retries, or unexpected events here:

(empty — no incidents yet)
```

### Rules

- Update **immediately** after every state change (not at the end of a session)
- Include commit hashes for merges
- Include ticket pass/fail counts for cmcs runs
- The incident log is append-only — never delete entries

---

## 5. Tickets

**Directory:** `tickets/<phase-label>/TICKET-NNN.md`

### Ticket format

```markdown
---
title: "Short imperative description"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

One sentence describing the outcome.

## Task

1. **`path/to/file.ts`** (line ~N, `FunctionOrBlock`):
   - Exact description of the change
   - Include before/after code snippets when the change is non-obvious
   - Reference supporting artifacts by path when needed

2. **`path/to/other-file.ts`** (line ~M):
   - ...

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'expectedPattern' path/to/file.ts` returns N
- Specific behavioral checks relevant to this ticket
```

### Ticket writing principles

- **Exact file paths and line numbers.** Codex works from the worktree root — it needs precise locations.
- **Code snippets for non-obvious changes.** Show the before/after pattern, not just "update the function."
- **Acceptance criteria are runnable commands.** `grep`, `wc -l`, build commands — things that return pass/fail.
- **Always include build + tsc + test** in acceptance criteria, even if the ticket seems small.
- **Reference data artifacts inline.** If a ticket needs a mapping table, tell Codex exactly where to find it: "Use the mapping at `DESIGN-MAPPING-TABLE.ts` in the worktree root" — and make sure the file is actually copied there (Codex can't access paths outside its worktree).
- **Set `reasoning_effort` appropriately.** Mechanical renames → `low`. Multi-file refactors → `medium`. Complex logic changes → `high`. Architectural decisions → `xhigh`.

### Special ticket types

- **`agent: "human"`** — for manual steps (D1 migrations, DNS changes). Not executed by cmcs, but documented in the ticket folder for completeness. Include a full runbook with validation gates and rollback.
- **Runbooks** (e.g., `D1-MIGRATION-RUNBOOK.md`) — placed alongside tickets in the phase folder. Not picked up by cmcs but referenced from the execution handover.

---

## Verification and Refinement

Documentation quality determines execution quality. Sloppy tickets produce sloppy output; ambiguous handovers produce confused orchestrators. The verification phase is not optional — it is where you catch the mistakes that would otherwise surface as production incidents.

Run these three verification passes **in order** after all documents and tickets are drafted. Each pass targets a different failure mode.

### Pass 1: Orchestrator Document Quality

**Goal:** Ensure the orchestrator (Claude) has everything needed to execute flawlessly across context compactions and session boundaries.

**Prompt to use (adapt to your project):**

> Is there any critical lack in our `<project-name>` documentation? Do you have everything you need to perform flawlessly as the Orchestrator — coordinating Codex agents, reviewing their output, managing merges, handling failures, and deploying? Is the current documentation sufficient for you to perform this task consistently even after context compaction/clear? If not, adjust.

**What this catches:**

- Missing rollback procedures that would leave you stranded mid-failure
- Handover gaps that force re-discovery after context compaction
- Implicit knowledge that isn't written down (e.g., "merge order matters because X")
- Missing pre-flight checks or smoke tests
- Unclear ownership of manual vs automated steps

**Expected output:** Additions to the execution handover, new sections in the progress tracker, clarified merge instructions, additional smoke test commands. May also surface the need for entirely new documents (e.g., a dedicated runbook for a complex manual step).

### Pass 2: Ticket Quality

**Goal:** Ensure every ticket is precise enough that a Codex agent can execute it without interpretation, guessing, or reading other documents.

**Prompt to use:**

> Now the tickets — they are the lifeblood of this plan. Verify each ticket one by one and make sure they are the best they can be: 1) accurate to the plan 2) as clear as they can be 3) as detailed and specific as they can be (leaving no room for agent interpretation) 4) using the right reasoning effort level for the job.

**Verification criteria per ticket:**

| Dimension | Check |
|-----------|-------|
| **Accuracy** | Does the ticket match the implementation plan? Are file paths still correct? Do line numbers reflect the current codebase? |
| **Clarity** | Could a developer unfamiliar with the project execute this ticket from its text alone? Are there ambiguous pronouns ("update it", "fix the function")? |
| **Specificity** | Are all files listed explicitly? Are before/after code snippets included for non-obvious changes? Are edge cases called out? |
| **Completeness** | Does the ticket handle all instances, not just the obvious ones? (e.g., "re-key 7 config maps" — are all 7 listed?) |
| **Acceptance criteria** | Are they runnable commands with expected outputs? Do they catch both "did the change" and "didn't break anything"? |
| **Reasoning effort** | Is it calibrated? Mechanical renames at `low`/`medium`, logic changes at `high`, architectural decisions at `xhigh`? |
| **Scope** | Is the ticket narrowly focused? If it does two logically independent things, split it. cmcs agents perform best on narrowly focused tasks. |
| **Artifact access** | If the ticket references a data file (mapping table, SQL draft), is that file accessible from the worktree? Is the copy step documented in the handover? |

**Parallelization:** For projects with many tickets, spawn one sub-agent per ticket (or per phase) to verify in parallel. Each agent reads the ticket, the relevant section of the implementation plan, and the current codebase files the ticket targets — then reports issues.

### Pass 3: Full Coherence Loop

**Goal:** Catch cross-document inconsistencies, stale references, and gaps that only surface when reading everything together.

**This is an iterative loop — repeat until clean.**

#### Loop logic:

1. Perform one exhaustive check of the entire project documentation folder
2. Categorize every issue found by severity: **Critical** (blocks execution or risks production), **High** (will cause Codex failure or require manual intervention), **Medium** (unclear but probably workable), **Low** (cosmetic or minor)
3. Fix all issues found
4. **If more than 1 Medium+ issue was found, loop again** — fixes can introduce new inconsistencies
5. Stop when a loop finds 0 Critical, 0 High, and at most 1 Medium issue

#### What to check in each loop:

| Category | Checks |
|----------|--------|
| **Cross-references** | Do tickets reference correct file paths? Do handover commands match ticket folder names? Does the plan's ticket count match the actual ticket files? |
| **Phase coherence** | Do phase gates in the plan match review checklists in the handover? Are merge orders consistent between plan and handover? |
| **File ownership** | Do parallel worktrees within a phase have strictly non-overlapping file lists? Is every file mentioned in a ticket accounted for in exactly one worktree? |
| **Command correctness** | Are all shell commands syntactically valid? Do paths use the right worktree convention? Are `cmcs` commands using full paths? |
| **Data flow** | If Phase N produces an artifact that Phase N+1 consumes, is that dependency documented? Is the artifact copy step in the handover? |
| **Edge cases** | Are all special cases from the design document reflected in tickets? (e.g., dead entries, collision resolution, large tables needing batched operations) |
| **Rollback completeness** | Does every phase have a rollback procedure? Does rollback cover both code and data? Are rollback commands tested (or at least syntactically valid)? |
| **Smoke test coverage** | Do smoke tests cover every endpoint/feature that changes in each phase? Are expected values specified (not just "expect success")? |
| **Staleness** | Are line numbers in tickets still accurate? Have any target files been modified since tickets were written? |

#### Prompt to use:

> Perform one exhaustive check of the whole `docs/plans/<project-name>/` documentation to make sure it's flawless, precise, coherent, clear and executable without any ambiguity. Tickets should be decomposed in the smallest logical chunk possible: cmcs agents perform best on narrowly focused tasks. Take all the time you need and spawn as many sub-agents as needed. The more precise our documentation is, the lower the chances of critical issues during execution.

**Spawn sub-agents liberally.** A typical coherence check benefits from parallel agents covering: (1) tickets vs plan consistency, (2) handover commands vs folder structure, (3) file ownership overlap detection, (4) codebase staleness detection (do the files/lines tickets reference still match?).

### When to re-run verification

- After any ticket is modified or split
- After new phases or worktrees are added
- After the codebase changes between planning and execution (run at minimum the staleness checks from Pass 3)
- After context compaction, if you're unsure whether the documentation reflects the latest state

---

## Preparation Checklist

Before considering preparation complete (all verification passes done), verify:

- [ ] Research worktrees produced all needed DESIGN-* artifacts
- [ ] Design document covers problem, goal, schema, migration, API, frontend, risks
- [ ] Implementation plan has phases, worktrees, tickets, gates, and dispatch summary
- [ ] All tickets are written with exact paths, code snippets, and runnable acceptance criteria
- [ ] Execution handover has copy-paste commands for every phase
- [ ] Execution handover has review checklists with grep-based spot checks
- [ ] Execution handover has rollback procedures for every phase
- [ ] Execution handover has post-deploy smoke tests
- [ ] Execution handover has drift detection commands (if project spans sessions)
- [ ] Progress tracker is initialized with all phases and empty checkboxes
- [ ] Parallel worktrees within each phase touch non-overlapping files (document the file ownership)
- [ ] Supporting artifacts are referenced by exact path from tickets and handover
- [ ] Manual steps have dedicated runbooks with validation gates
- [ ] **Pass 1 (Orchestrator Quality)** completed — no gaps in handover or rollback
- [ ] **Pass 2 (Ticket Quality)** completed — every ticket verified for accuracy, clarity, specificity
- [ ] **Pass 3 (Coherence Loop)** completed — final loop found 0 Critical/High, at most 1 Medium

---

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Write tickets that say "update all files that use X" | List every file explicitly with line numbers |
| Put deployment logic inside cmcs tickets | Write a human runbook for deployment coordination |
| Assume Codex can access files outside its worktree | Copy supporting artifacts into the worktree before running |
| Skip acceptance criteria on "simple" tickets | Every ticket gets build + tsc + test at minimum |
| Merge parallel worktrees without checking file overlap | Document file ownership per worktree; verify no overlap |
| Deploy a phase that leaves code-DB out of sync | Combine code deploy and DB migration into a single maintenance window |
| Use `BEGIN`/`COMMIT` in D1 migration SQL | D1 doesn't support explicit transactions; use Time Travel for rollback |
| Push phase code to main without `[skip ci]` when DB hasn't migrated | Always `[skip ci]` when code depends on a not-yet-executed DB migration |
| Re-run failed tickets without reading the logs first | Diagnose, fix the ticket or code, then re-run |
| Claim a phase is done without running smoke tests | Verify runtime behavior with curl, not just build success |

---

## Reference Implementation

The [ticker-issuer ID migration](../plans/ticker-issue-migration/) is the canonical example of this process:

- 4 research worktrees producing DESIGN-* artifacts
- 4 phases, 8 worktrees, 19 tickets
- D1 migration runbook with maintenance window coordination
- Gradual deployment with instant rollback
- 30-day legacy compatibility window before cleanup phase

Study its structure when preparing a new large implementation.
