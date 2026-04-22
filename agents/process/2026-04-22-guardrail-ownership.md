# Guardrail Ownership

Date: 2026-04-22
Owner: Codex

## Purpose

The repository’s verification layer is large enough to require explicit ownership and review cadence. This artifact closes the `PR-16` planning requirement that the guardrail subsystem be treated as a maintained product, not an incidental script pile.

## Ownership

- Primary owner: the maintainer driving the next production-facing infra or CI change
- Default fallback owner: the maintainer preparing the next deploy-impacting `main` push

## Review cadence

- Review the custom guardrail inventory quarterly
- Review any touched guardrail immediately in the same PR that changes it
- Re-check the inventory after any Node/toolchain/runtime-line migration

## Retirement criteria

A custom check is eligible for retirement only when:

- a standard tool or platform-native mechanism covers the same guarantee
- the replacement is wired into CI and local validation
- the replacement preserves or improves current failure visibility
- docs and plan artifacts are updated to point at the replacement

## Priority inventory

- `scripts/check-env-contract.mjs`
- `scripts/check-hotspot-ratchet.mjs`
- `scripts/check-worker-migrations.mjs`
- `scripts/check-cron-abort-contract.mjs`
- `scripts/check-cron-connection-budget.ts`
- `scripts/check-doc-counts.mjs`
- `scripts/check-stablecoin-data.ts`
- `scripts/check-shared-cycles.mjs`
- `scripts/check-unused-code.mjs`

## Current stance

- Keep the current custom guardrails in place unless a replacement clearly preserves the same protection level.
- Prefer consolidating duplicated helper logic inside the guardrail layer before replacing whole checks.
