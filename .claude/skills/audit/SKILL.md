---
name: audit
description: Comprehensive codebase audit. Use when the user asks to audit, review, or check the health of the codebase. Explores frontend, worker, and API code in parallel, categorizes issues by severity, and delivers findings incrementally.
user_invocable: true
---

## Audit Skill

### Process

1. **Parallel exploration**: Use parallel task agents to explore frontend (`src/`), worker (`worker/src/`), and API code (`worker/src/api/`) simultaneously. Each agent should look for:
   - Type safety issues (any casts, missing types, unsafe assertions)
   - Dead code (unused exports, unreachable branches)
   - Security concerns (injection, unsanitized input, missing validation at boundaries)
   - Performance issues (unnecessary re-renders, missing memoization, N+1 queries)
   - Consistency violations (patterns that diverge from conventions in CLAUDE.md)
   - Missing error handling at system boundaries
   - Hardcoded values that should be constants or config

2. **Categorize issues by severity**:
   - **Critical**: Security vulnerabilities, data corruption risks, broken functionality
   - **Major**: Performance problems, type safety gaps, missing error handling at boundaries
   - **Minor**: Style inconsistencies, dead code, minor DRY violations

3. **Group into implementation tiers**:
   - **Tier 1** (quick wins): Issues fixable in <5 min each
   - **Tier 2** (moderate): Issues requiring careful changes across 1-3 files
   - **Tier 3** (significant): Issues requiring architectural changes or multi-file refactors

4. **Deliver findings incrementally**:
   - Show critical issues first with file paths and line numbers
   - Ask user if they want the full report before continuing
   - Present major/minor issues grouped by tier

5. **Build verification**: Always run `npm run build` before concluding to confirm the codebase compiles cleanly. Report any build errors as critical issues.

### Output Format

For each issue:
```
[SEVERITY] Category — Brief description
  File: path/to/file.ts:LINE
  Details: What's wrong and why it matters
  Suggested fix: Concrete recommendation
```
