# Synthesis & Triage Guide

After all 8 research reports are collected, the orchestrator follows this guide to produce the implementation plan and tickets.

## Step 1: Collect & Review Reports

- [ ] R1 (Code Quality: Frontend) — reviewed
- [ ] R2 (Code Quality: Worker & Shared) — reviewed
- [ ] R3 (UI/UX Quality) — reviewed
- [ ] R4 (Performance) — reviewed
- [ ] R5 (Data Integrity) — reviewed
- [ ] R6 (Design System Compliance) — reviewed
- [ ] R7 (Security & Dependencies) — reviewed
- [ ] R8 (Testing & Documentation) — reviewed

Read each report end-to-end. For each, note the total finding count and aggregate stats.

## Step 2: Deduplicate Cross-Report Findings

Research tickets have overlapping scope at the edges. Common overlaps:

| Report A | Report B | Likely Overlap |
|----------|----------|---------------|
| R1 (code quality) | R6 (design system) | Duplicated component patterns flagged as both LOC waste and design inconsistency |
| R2 (code quality) | R5 (data integrity) | Missing error handling flagged as both dead code opportunity and error gap |
| R3 (UI/UX) | R6 (design system) | Responsive issues flagged as both UX problem and spacing inconsistency |
| R4 (performance) | R1/R2 (code quality) | Large files flagged as both performance concern and extraction candidate |
| R7 (security) | R5 (data integrity) | Input validation flagged as both security risk and data integrity gap |
| R8 (testing) | all reports | Missing tests for issues found in other reports |

**Dedup rule:** Keep the finding in the report where it's most actionable. If R1 says "extract chart primitives to save 140 LOC" and R6 says "chart axis styling is inconsistent", the implementation ticket should address both — file it as a single ticket referencing both findings.

## Step 3: Prioritize Findings

Score each finding on two axes:

**Severity** (impact if not fixed):
- **Critical** — data incorrectness, security vulnerability, accessibility blocker, crashes, significant LOC savings (>50), or high maintenance burden
- **Important** — noticeable UX degradation, moderate tech debt, moderate LOC savings (10-50), or quality improvement
- **Minor** — polish, small LOC savings (<10), nice-to-have consistency improvements

**Effort** (cost to fix):
- **Low** — pure deletion, single-line change, config change (<30 min)
- **Medium** — extraction, refactoring, multi-file change (30 min – 2 hours)
- **High** — new abstraction, architecture change, many files (>2 hours)

**Priority matrix:**

|  | Low Effort | Medium Effort | High Effort |
|--|-----------|--------------|------------|
| **Critical** | Phase A (immediate) | Phase A (immediate) | Phase B (next) |
| **Important** | Phase A (immediate) | Phase B (next) | Phase C (later) |
| **Minor** | Phase B (next) | Phase C (later) | Backlog (defer) |

## Step 4: Group into Phases

### Phase A: Safe, High-Value Changes

Everything that is:
- Pure deletions (dead code, unused exports, unused files)
- Config/token fixes (design system corrections that don't change behavior)
- Critical security fixes
- Zero risk of behavior change

**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test`

### Phase B: Behavior-Preserving Refactors

Everything that:
- Extracts shared helpers or components (consolidation)
- Restructures code without changing behavior
- Adds missing error/loading/empty states (additive, not modifying)
- Fixes a11y issues (additive — ARIA labels, focus management)

**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test` + manual spot-check of affected pages

### Phase C: Deeper Changes

Everything requiring:
- New abstractions or architecture changes
- Performance optimizations that change rendering patterns
- Test infrastructure overhaul
- Documentation rewrites

**Gate:** Full test suite + visual regression check on key pages

### Backlog

Items deferred for future audit runs. Document in PROGRESS.md under "Deferred items."

## Step 5: Write Implementation Tickets

For each phase, group related findings into tickets. Follow these rules:

### Ticket Granularity

- **One ticket = one worktree = non-overlapping files.** No two tickets within the same phase should modify the same file.
- **Target:** 30-120 minutes of agent work per ticket. Split larger tasks; merge trivial ones.
- **Scope ceiling:** A ticket should touch at most ~15 files. Beyond that, split it.

### Ticket Organization

Within each phase, organize tickets by codebase area to ensure non-overlapping files:

```
tickets/
  phase-a/
    TICKET-001.md  (frontend dead code)
    TICKET-002.md  (worker dead code)
    TICKET-003.md  (shared dead code)
    TICKET-004.md  (design token fixes)
    TICKET-005.md  (security fixes)
  phase-b/
    TICKET-006.md  (chart component consolidation)
    TICKET-007.md  (worker helper extraction)
    ...
```

### Ticket Content

Use `synthesis/implementation-ticket-template.md` for the format. Each ticket must:
- Reference the research report finding(s) it addresses
- List exact files to modify (for overlap verification)
- Include specific acceptance criteria (commands to run, greps to verify)
- Specify model and effort level (see README.md dispatch reference)

### File Overlap Verification

Before finalizing tickets within a phase, verify no file appears in more than one ticket:

```bash
# Extract all file paths from tickets in a phase, sort, check for duplicates
grep -h '^\- \*\*' tickets/phase-a/*.md | grep -oP '`[^`]+`' | sort | uniq -d
# Should output nothing — any output means file overlap between tickets
```

## Step 6: Write the Implementation Plan

Create `implementation-plan.md` in the audit run directory with:

```markdown
# Codebase Quality Audit — Implementation Plan

## Execution Strategy
- **N phases**, sequential gates
- **N worktrees** across phases (breakdown per phase)
- **N tickets** total

## Phase A: [Name] (~estimated LOC impact)
| Worktree | Ticket | Key Files | Est. LOC | Model | Effort |
|----------|--------|-----------|----------|-------|--------|
| `audit-slug` | TICKET-001 | file1, file2 | -N | spark | medium |
| ... | ... | ... | ... | ... | ... |

**Dispatch:** All N in parallel (non-overlapping files).
**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test`

## Phase B: [Name]
...

## Phase C: [Name]
...

## Total Estimated Impact
- LOC: -N
- Findings resolved: N/N
- Deferred: N items (listed in PROGRESS.md)
```

## Step 7: Update Progress Tracker

Update PROGRESS.md with the implementation phases, ticket assignments, and gate criteria.

## Common Pitfalls

- **Over-scoping tickets:** Keep them focused. A ticket that tries to do 5 unrelated things will confuse the agent.
- **Under-verifying overlaps:** Two tickets touching the same file will cause merge conflicts. Always verify.
- **Skipping the gate:** Never advance to the next phase without passing the gate. If the gate fails, debug and fix before proceeding.
- **Ignoring research quality:** If a research report is shallow (few findings, no line references), re-run it or investigate manually before proceeding to implementation.
- **Treating deferred items as forgotten:** Add them to the backlog explicitly. They're inputs for the next audit run.
