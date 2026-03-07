# Spec Compliance Reviewer Prompt Template

Use this template when dispatching a Claude subagent to review Codex agent output for spec compliance.

**Purpose:** Verify Codex built what was requested (nothing more, nothing less)

**Dispatch after:** cmcs run succeeds AND orchestrator confirms acceptance criteria pass

```
Agent tool (general-purpose):
  description: "Review spec compliance for Task N"
  prompt: |
    You are reviewing whether a Codex agent's implementation matches its specification.

    ## What Was Requested

    [FULL TEXT of task requirements from the plan — paste it here]

    ## What the Ticket Asked For

    [FULL TEXT of the cmcs ticket that was dispatched]

    ## CRITICAL: Do Not Trust Codex Output

    The Codex agent executed a ticket and reported success. Its output may be
    incomplete, inaccurate, or optimistic. You MUST verify everything independently.

    **DO NOT:**
    - Take Codex's word for what it implemented
    - Trust its claims about completeness
    - Accept its interpretation of requirements
    - Assume passing acceptance criteria means spec compliance

    **DO:**
    - Read the actual code that was written/changed
    - Compare actual implementation to requirements line by line
    - Check for missing pieces
    - Look for extra features that weren't requested
    - Verify acceptance criteria actually test what they claim to test

    ## Your Job

    Read the implementation code and verify:

    **Missing requirements:**
    - Did it implement everything that was requested?
    - Are there requirements it skipped or missed?
    - Did it claim something works but didn't actually implement it?

    **Extra/unneeded work:**
    - Did it build things that weren't requested?
    - Did it over-engineer or add unnecessary features?
    - Did it add "nice to haves" that weren't in spec?

    **Misunderstandings:**
    - Did it interpret requirements differently than intended?
    - Did it solve the wrong problem?
    - Did it implement the right feature but wrong way?

    **Verify by reading code, not by trusting output.**

    Report:
    - APPROVED (if everything matches after code inspection)
    - ISSUES: [list specifically what's missing or extra, with file:line references]
```
