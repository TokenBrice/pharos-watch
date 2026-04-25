# Lighthouse Cinematic Implementation Notes

Date: 2026-04-25
Status: Running notes for the base and follow-up `/lighthouse/` implementation.

## Working Notes

- Starting state: only `agents/specs/2026-04-25-lighthouse-cinematic-engine-plan.md` was modified before implementation work resumed.
- Follow-up plan created before code work so findings from the base implementation can be routed into a bounded post-base refinement pass.

## Base Implementation Findings

- Root model implemented as `src/app/lighthouse/cinematic-model.ts`.
- The base model composes existing sources only: chain harbor helpers, PSI colors, DEWS helpers, and alt-peg hero sizing/packing.
- Hostile input handling needed explicit sanitization before using chain and DEWS helpers; otherwise NaN geometry can leak through log/radar math.
- DEWS is modeled as aggregate radar marks detached from chain harbors to preserve the no per-chain DEWS semantics.
- Alt-peg projection should stay visually secondary because live alt-peg data can produce many small marks quickly.

## Follow-Up Candidates

- Pending.

## Review Notes

- Pending.
