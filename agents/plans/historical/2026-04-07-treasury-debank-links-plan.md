# Treasury Debank Links Plan

## Goal
Add Debank links on the treasury page for each tracked treasury without changing the worker/API payload.

## Constraints
- Keep the change local to the frontend when possible.
- Reuse the reviewed treasury seed registry as the source of tracked owner wallets.
- Preserve existing table structure and Pharos visual language.
- Add/adjust tests for the new link rendering.

## Plan
1. Inspect the treasury table expansion area and map treasury entities to seed-owner metadata by slug.
2. Add a small frontend helper for Debank profile URLs and human-readable owner labels.
3. Render Debank links in the expanded treasury details, with a clear fallback when no reviewed owner wallets exist.
4. Update the treasury table test coverage and run the relevant validation commands.
