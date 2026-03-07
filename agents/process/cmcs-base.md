### Dispatch

```
Dependent tasks?  → Same worktree, sequential tickets (TICKET-001, 002, ...)
Independent tasks? → Separate worktrees, parallel runs
Single task?       → Single worktree, single ticket
```

**Parallel dispatch:** Launch all parallel `cmcs run` commands in a single shell call with `&` backgrounding. Claude Code throttles concurrent Bash tool calls (~2 at a time), causing ~2 min staggered starts if dispatched as separate tool calls.

```bash
# CORRECT — true parallel launch
cmcs run worktrees/branch-a 2>&1 &
cmcs run worktrees/branch-b 2>&1 &
cmcs run worktrees/branch-c 2>&1 &
wait
```

### Ticket Format

Place in `.cmcs/tickets/TICKET-001.md` (or `<worktree>/.cmcs/tickets/`):
cmcs agents perform best on narrowly focused tasks. Tickets should be decomposed in the smallest logical chunk possible and using the appropriate `reasoning_effort` and `model` for the task.

**Model selection:**

| Model | Use When |
|-------|----------|
| `gpt-5.4` | Ambiguous/architectural tickets needing reasoning + coding. Default when unsure. |
| `gpt-5.3-codex` | Well-scoped coding with clear specs. Best cost/performance for standard work. |
| `gpt-5.3-codex-spark` | Mechanical/rote: renames, string replacements, config fixes, boilerplate. |
| `gpt-5.1-codex-max` | Marathon tickets: 10+ files, sustained coherence, huge refactors. |

See `agents/process/cmcs-large-implementation-preparation.md` for the full model guide.

```markdown
---
title: "Short imperative description"
agent: "codex"
model: "gpt-5.4"  # see model selection guide above
reasoning_effort: "high"         # optional: low, medium, high, xhigh (default: xhigh)
done: false
---

## Goal
One sentence.

## Task
Numbered steps with exact file paths, function signatures, behavior.

## Acceptance Criteria
Concrete runnable checks.
```

### Commands

```bash
cmcs init                        # once per repo
cmcs worktree create <branch>    # parallel workspace
cmcs run <path>                  # process tickets (. for current repo)
cmcs status                      # all runs
cmcs wait <path>                 # block until done
cmcs stop <path>                 # terminate run
cmcs logs <path>                 # view agent output
cmcs dashboard                   # web UI
```

### Rules

- **Never use Claude sub-agents for implementation.** All work goes to Codex via tickets.
- **Never auto-merge.** Review every file Codex creates, run acceptance criteria yourself.
- **Never run sudo.**

### Large Implementation Preparation

**`/agents/process/cmcs-large-implementation-preparation.md`** — Preparation process for large multi-phase projects executed via cmcs: research → design → implementation plan → execution handover → tickets. **Read before planning any task that touches 10+ files or spans multiple worktrees.**

### Post-Execution Retrospective

After completing a cmcs execution (all phases merged), record what worked and what didn't. Place in `agents/retrospectives/<date>-<project>.md`:

```markdown
# Retrospective: <project> (<date>)

## Stats
- Tickets: N total, M first-pass success, K needed rework
- Models: codex for X tickets, spark for Y tickets

## What worked
- [e.g., "spark handled all rename tickets perfectly"]

## What didn't
- [e.g., "TICKET-003 needed 3 rework cycles — too vague on edge cases"]

## Lessons for next time
- [e.g., "always include before/after snippets for type signature changes"]
- [e.g., "spark can't handle cross-file type propagation — use codex"]
```