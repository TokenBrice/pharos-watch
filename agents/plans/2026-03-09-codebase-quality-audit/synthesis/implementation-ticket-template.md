# Implementation Ticket Template

Copy this template for each implementation ticket. Fill in all sections.

---

```markdown
---
title: "[Verb] [what] in [where]"
agent: "codex"
model: "[gpt-5.3-codex-spark | gpt-5.3-codex]"
reasoning_effort: "[medium | high | xhigh]"
done: false
---

## Goal

[One sentence: what this ticket achieves and why it matters.]

## Context

[2-3 sentences: relevant background. Reference the research report finding(s) this addresses.]

**Research findings addressed:**
- R{N} Finding {C/I/M}{N}: [short description]
- R{N} Finding {C/I/M}{N}: [short description]

## Task

### 1. [First change group]

[Specific instructions with exact file paths and line numbers. Tell the agent exactly what to do.]

- **`path/to/file.ts`** (~line N): [what to change and why]
- **`path/to/file.ts`** (~line N): [what to change and why]

### 2. [Second change group]

[...]

### 3. [Third change group, if needed]

[...]

## Files Modified

List every file this ticket will touch (for overlap verification):

- `path/to/file1.ts`
- `path/to/file2.ts`
- `path/to/file3.ts`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- [Specific grep or check verifying the change was made correctly]
- [Specific grep or check verifying nothing was broken]
- [Additional verification as needed]
```

---

## Model & Effort Selection Guide

| Ticket Type | Model | Effort | Rationale |
|-------------|-------|--------|-----------|
| Pure deletions (dead code, unused exports) | `gpt-5.3-codex-spark` | `medium` | Simple, mechanical changes |
| Config fixes (token corrections, class swaps) | `gpt-5.3-codex-spark` | `medium` | Search-and-replace with judgment |
| Helper extraction (DRY consolidation) | `gpt-5.3-codex` | `high` | Needs to understand usage patterns |
| Component refactoring (new abstractions) | `gpt-5.3-codex` | `xhigh` | Architecture decisions involved |
| A11y / responsive fixes | `gpt-5.3-codex` | `high` | Needs design awareness |
| Security fixes | `gpt-5.3-codex` | `high` | Must not introduce regressions |
| Test writing | `gpt-5.3-codex` | `high` | Needs to understand expected behavior |
| Documentation updates | `gpt-5.3-codex-spark` | `medium` | Factual corrections, low risk |

## Writing Tips

- **Be specific.** "Remove the export keyword from line 42" is better than "clean up exports."
- **Give context.** The agent doesn't know why a change is needed unless you explain.
- **Include verification.** Greps, wc-l comparisons, and specific checks catch implementation mistakes.
- **State what NOT to change.** If a file has similar patterns that should remain, call that out explicitly.
- **Reference constraints.** If there are Pharos-specific rules (Tailwind static strings, classification colors from shared/lib, etc.), remind the agent.
