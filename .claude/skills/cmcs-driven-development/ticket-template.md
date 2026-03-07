# Ticket Template for cmcs-Driven Development

Use this template when writing cmcs tickets for Codex agents.

**Critical:** Tickets must be completely self-contained. Codex agents cannot:
- Ask clarifying questions
- Read the plan file or design docs
- Access files outside their worktree
- Infer intent from context

Everything the agent needs must be **in the ticket itself**.

## Template

```markdown
---
title: "Short imperative description"
agent: "codex"
model: "gpt-5.4"                  # see model guide below
reasoning_effort: "high"          # low, medium, high, xhigh (default: xhigh)
done: false
---

## Goal

One sentence describing the concrete outcome.

## Context

[WHY this change is needed. What system/feature it's part of. How it fits with
other changes. Include any architectural context the agent needs.]

## Task

1. **`path/to/file.ts`** (line ~N, `FunctionOrBlock`):
   - Exact description of the change
   - Before/after code snippets when the change is non-obvious:
     ```ts
     // Before
     const old = doThing();
     // After
     const new = doOtherThing();
     ```

2. **`path/to/other-file.ts`** (line ~M):
   - ...

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'expectedPattern' path/to/file.ts` returns N
- [Specific behavioral checks relevant to this ticket]
```

## Model Selection Guide

| Model | Use When |
|-------|----------|
| `gpt-5.4` | Ambiguous/architectural tickets needing reasoning + coding. Default when unsure. |
| `gpt-5.3-codex` | Well-scoped coding with clear specs. Best cost/performance for standard work. |
| `gpt-5.3-codex-spark` | Mechanical/rote: renames, string replacements, config fixes, boilerplate. |
| `gpt-5.1-codex-max` | Marathon tickets: 10+ files, sustained coherence, huge refactors. |

When unsure, use `gpt-5.4`.

## Reasoning Effort Guide

| Level | Use When |
|-------|----------|
| `low` | Mechanical renames, path fixes, string replacements |
| `medium` | Multi-file refactors with clear patterns |
| `high` | Logic changes, new features with defined specs |
| `xhigh` | Architectural decisions, complex edge cases, safety-critical changes |

## Ticket Writing Principles

1. **Exact file paths and line numbers.** Codex works from the worktree root — it needs precise locations.
2. **Code snippets for non-obvious changes.** Show the before/after pattern, not just "update the function."
3. **Acceptance criteria are runnable commands.** `grep`, `wc -l`, build commands — things that return pass/fail.
4. **Always include build + tsc + test** in acceptance criteria, even for small tickets.
5. **Reference data artifacts inline.** If a ticket needs a mapping table, tell Codex exactly where to find it — and make sure the file is copied into the worktree.
6. **One logical change per ticket.** If a ticket does two independent things, split it. Codex performs best on narrowly focused tasks.
7. **List every file explicitly.** Never say "update all files that use X" — enumerate them with paths and line numbers.

## Fix Tickets

When a reviewer finds issues, write a targeted fix ticket:

```markdown
---
title: "Fix: [what needs fixing]"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Fix [specific issue] identified during review.

## Context

The previous ticket (TICKET-NNN) implemented [feature]. Review found:
- [Issue 1: file:line — what's wrong and what it should be]
- [Issue 2: ...]

## Task

1. **`path/to/file.ts`** (line ~N):
   - [Exact fix]

## Acceptance Criteria

- `npm run build` exits 0
- `npm test` exits 0
- [Specific check that the fix is correct]
- [Specific check that the original issue is gone]
```

Fix tickets should use lighter models/effort since the problem is already well-defined.
