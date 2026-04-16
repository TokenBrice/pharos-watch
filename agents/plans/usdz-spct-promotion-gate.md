# USDz / SPCT Evidence Gate

> Decision record for `anzen-usdz` live reserve classification.

> Date: 2026-04-16

> Source plan: `agents/plans/2026-04-16-reserve-sync-remediation-and-expansion.md` (Task 7.2)

> Status: **gate open — do not promote**

---

## Current state

- Adapter: `anzen-usdz`
- Evidence class in registry: `weak-live-probe` (see `shared/lib/live-reserve-adapters-definitions.ts`)
- Snapshot mode served: `live` via a single-asset liveness probe — the adapter confirms the token is being issued and that the SPCT mint is readable on-chain, but it does **not** publish per-asset portfolio composition.

USDz is backed 1:1 by SPCT (Secured Private Credit Tokens). Anzen publishes a transparency landing page at `https://rwa.anzen.finance/transparency` and an overview in `https://docs.anzen.finance/usdz-101/transparency`, but neither surface exposes per-asset portfolio snapshots or attestation timestamps that a reserve adapter can consume.

## Promotion prerequisites

The `anzen-usdz` adapter may be promoted out of `weak-live-probe` only when **one** of the following ships:

1. **Per-asset SPCT portfolio snapshot with attestation timestamp** published via one of:
   - Chainlink Proof-of-Reserve feed on a supported chain.
   - rwa.xyz Enterprise Data API entry with per-asset balances and `asOf` timestamps.
   - Monthly audit PDF with machine-parseable tables and a consistent cadence.
2. **Reviewed off-chain attestation** that is machine-parseable (HTML/JSON table or structured PDF) and refreshed at least monthly.
3. **Audit firm live dashboard** reachable via the rwa.xyz Enterprise Data API or an equivalent timestamped third-party feed.

Each prerequisite must include:

- A current-as-of timestamp the adapter can validate against the shared `maxSourceAgeSec` / source-freshness policy.
- Per-asset balances with disclosed asset identifiers so the existing classification helpers can map them to reserve slices with honest risk tiers.

## Current gap (verified 2026-04-16)

WebFetch against `https://docs.anzen.finance/usdz-101/transparency` confirms Anzen does not currently publish:

- A Chainlink Proof-of-Reserve feed.
- An rwa.xyz Enterprise Data API integration.
- A machine-parseable monthly audit PDF with per-asset SPCT composition.

The transparency page offers general reserve visibility only, without the granular per-asset attestation data required for a promotion.

## Decision

- Keep `anzen-usdz` at `evidenceClass: "weak-live-probe"` in `shared/lib/live-reserve-adapters-definitions.ts`.
- Do not modify `worker/src/cron/reserve-adapters/anzen-usdz.ts`.
- Do not relax the shared freshness gate to accept a coarse issuer page.
- Revisit monthly via the review log in `agents/tasks/reserve-coverage-tracker.md`.

## Operational notes

- When any prerequisite ships, the follow-up work must also add scoring-eligible freshness evidence (`sourceTimestamp` or `freshnessMode: not-applicable`) before the adapter's evidence class is raised.
- If rwa.xyz Enterprise Data API becomes the path, confirm whether the same integration can promote other deferred coins in the coverage tracker (e.g., Avalon USDA, Astherus USDF) before scoping per-adapter work.
- The `reserve-coverage-tracker.md` weak-probe-ceiling section points here for USDz.

## References

- Plan: `agents/plans/2026-04-16-reserve-sync-remediation-and-expansion.md` Task 7.2
- Tracker: `agents/tasks/reserve-coverage-tracker.md`
- Adapter registry: `shared/lib/live-reserve-adapters-definitions.ts`
- Current adapter: `worker/src/cron/reserve-adapters/anzen-usdz.ts`
