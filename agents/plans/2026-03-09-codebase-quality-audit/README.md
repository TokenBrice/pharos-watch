# Codebase Quality Audit — Template

Comprehensive, repeatable audit template for the Pharos codebase. Covers code quality, UI/UX, performance, data integrity, design system compliance, security, testing, and documentation.

## When to Use

- Periodic health check (e.g., quarterly)
- Before major releases
- After rapid feature development
- When onboarding reveals friction or inconsistencies
- When tech debt feels like it's accumulating

## Execution Flow

```
Phase 0: Research (parallel)          Phase 1: Synthesis           Phase 2+: Implementation
┌─────────────────────────┐          ┌──────────────────┐         ┌──────────────────────┐
│ R1  Code quality (fe)   │          │                  │         │ Phase A: Safe cleanup │
│ R2  Code quality (be)   │          │ Review 8 reports │         │ Phase B: Refactoring  │
│ R3  UI/UX quality       │  ──────> │ Triage findings  │ ──────> │ Phase C: Deeper work  │
│ R4  Performance         │          │ Group into phases│         │ ...                   │
│ R5  Data integrity      │          │ Write impl tix   │         │ (phases are dynamic)  │
│ R6  Design system       │          │                  │         │                       │
│ R7  Security & deps     │          └──────────────────┘         └──────────────────────┘
│ R8  Testing & docs      │
└─────────────────────────┘
```

### Phase 0: Research (parallel, ~8 cmcs runs)

Dispatch all 8 research tickets as parallel cmcs runs. Each produces a `RESEARCH-REPORT.md` with structured findings. All are read-only — no code changes.

### Phase 1: Synthesis (orchestrator)

The orchestrator (you) reviews all 8 reports, follows `synthesis/triage-guide.md` to:
1. Deduplicate cross-report findings
2. Prioritize by severity x effort
3. Group into risk-ordered phases
4. Write implementation tickets using `synthesis/implementation-ticket-template.md`
5. Write the implementation plan (phase table, worktree assignments, dispatch order)

### Phase 2+: Implementation (parallel cmcs runs per phase)

Execute implementation tickets phase by phase. Each phase gates on `npm run build && cd worker && npx tsc --noEmit && npm test`. Phases are dispatched in order; tickets within a phase run in parallel (non-overlapping files).

## File Inventory

```
README.md                                  # This file
PROGRESS-TEMPLATE.md                       # Copy per audit run, track progress

research/
  R1-code-quality-frontend.md              # Dead code, duplication, consolidation in src/
  R2-code-quality-worker-shared.md         # Same for worker/src/ and shared/
  R3-ui-ux-quality.md                      # Responsive, a11y, loading/error/empty states
  R4-performance.md                        # Bundle, rendering, lazy loading, network
  R5-data-integrity.md                     # Validation, error handling, edge cases
  R6-design-system-compliance.md           # Token usage, typography, spacing, color
  R7-security-dependencies.md              # Input validation, XSS, dependency health
  R8-testing-documentation.md              # Coverage gaps, test quality, doc drift

synthesis/
  triage-guide.md                          # How to review, prioritize, group findings
  implementation-ticket-template.md        # Format for implementation tickets
```

## Outputs (generated per run)

These are NOT part of the template — they're produced during each audit run:

- `PROGRESS.md` — copied from PROGRESS-TEMPLATE.md, updated as work progresses
- `research-reports/R{N}-REPORT.md` — one per research ticket
- `implementation-plan.md` — generated during synthesis
- `tickets/phase-{N}/TICKET-{NNN}.md` — generated implementation tickets

## Dispatch Reference

Research phase (all 8 in parallel):
```bash
# 1. Create worktrees
cmcs worktree create research-audit-r1
cmcs worktree create research-audit-r2
# ... through r8

# 2. Copy tickets into worktrees
cp research/R1-code-quality-frontend.md worktrees/research-audit-r1/.cmcs/tickets/TICKET-001.md
cp research/R2-code-quality-worker-shared.md worktrees/research-audit-r2/.cmcs/tickets/TICKET-001.md
# ... etc

# 3. Launch all in parallel
cmcs run worktrees/research-audit-r1 2>&1 &
cmcs run worktrees/research-audit-r2 2>&1 &
cmcs run worktrees/research-audit-r3 2>&1 &
cmcs run worktrees/research-audit-r4 2>&1 &
cmcs run worktrees/research-audit-r5 2>&1 &
cmcs run worktrees/research-audit-r6 2>&1 &
cmcs run worktrees/research-audit-r7 2>&1 &
cmcs run worktrees/research-audit-r8 2>&1 &
wait
```

Implementation phase (per phase, tickets in parallel within phase):
```bash
# Same pattern: create worktree, copy ticket, run
cmcs worktree create audit-{ticket-slug}
cp tickets/phase-{N}/TICKET-{NNN}.md worktrees/audit-{ticket-slug}/.cmcs/tickets/TICKET-001.md
cmcs run worktrees/audit-{ticket-slug}
```

Note: Model and effort are set in each ticket's frontmatter, not via CLI flags.

Model selection:
- **Research tickets**: `gpt-5.3-codex` with `xhigh` effort — research needs thorough analysis
- **Safe cleanup tickets** (deletions, de-exports): `gpt-5.3-codex-spark` with `medium` effort
- **Refactoring tickets** (extraction, consolidation): `gpt-5.3-codex` with `high` effort
- **Complex tickets** (architecture changes, new abstractions): `gpt-5.3-codex` with `xhigh` effort
