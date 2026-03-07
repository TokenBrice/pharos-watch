### Dispatch

```
Dependent tasks?  → Same worktree, sequential tickets (TICKET-001, 002, ...)
Independent tasks? → Separate worktrees, parallel runs
Single task?       → Single worktree, single ticket
```

### Ticket Format

Place in `.cmcs/tickets/TICKET-001.md` (or `<worktree>/.cmcs/tickets/`):
cmcs agents perform best on narrowly focused tasks. Tickets should be decomposed in the smallest logical chunk possible and using the appropriate `reasoning_effort` and `model` for the task.

**Model selection:** `gpt-5.3-codex` for complex multi-file refactors. `gpt-5.3-codex-spark` for repetitive pattern application. `gpt-5.3-codex-mini` for mechanical/rote fixes. When unsure, use `gpt-5.3-codex`. See `agents/process/cmcs-large-implementation-preparation.md` for the full model guide.

```markdown
---
title: "Short imperative description"
agent: "codex"
model: "gpt-5.3-codex"  # see model selection guide above
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