---
name: scenario-verification
description: Re-read pinned on-chain facts and source fingerprints behind failure scenarios and report drift. Use monthly or after governance, custody or contract changes. Not for approving or editing records.
---

# Scenario Verification

## Trigger And Exclusions

Run at least monthly, and after a known governance, custody, role, or contract change relevant to a published note. The output is a drift report plus a proposed maintainer decision per coin.

Not for approving, editing or retiring records. Approval is one-time and content-bound ([One-time maintainer approval](../../../docs/process/failure-scenarios.md#one-time-maintainer-approval)); a monthly read never renews it.

## Classify The Operation

Corpus re-read, focused single-coin re-read, or a deliberate document-baseline refresh after a human reviewed a changed source.

## Mandatory Core

- Read `docs/process/failure-scenarios.md` first. Authorities: the record in `data/failure-scenarios.json`, schemas and the publication selector in `shared/lib/failure-scenarios.ts`, checks in `shared/lib/failure-scenario-checks/`, and reviewed document baselines in `shared/data/failure-scenario-documents.json`.
- Enumerate the current registry and records; never hard-code a coin roster. The verifier includes drafts so checks can run before publication: keep them distinct from approved notes.
- `scenarios:approve` is maintainer-only; never invoke it, even with prior approval of research work. The verifier never writes `data/failure-scenarios.json` and must never broadcast a transaction.
- Exit `0` is not complete verification. Unavailable reads, figure drift, observations and document watches never fail the run; inspect every unavailable item and never treat it as holds, zero, or proof the note remains valid.
- Ignored `agents/` scratch is evidence, not publication authority. When retained evidence is absent, reconstruct the read from the record's cited sources and disclose the missing baseline.

## Branch Reads And Actions

- **Collect a pinned report:** run `npm run verify:failure-scenarios` (`-- --coin <id>` for one coin, `-- --json` for the machine-readable report). The runner loads the ignored `.env.local`; checks that scan event logs need a log-capable RPC provider, and PDF reads need Poppler's `pdftotext`. Keep reports under ignored `agents/` with stdout JSON intact and command errors alongside. By default each required chain's head is resolved once; `-- --block <n>` sets that height on every required chain, which is not a shared cross-chain instant. Record the mode and never label an old override as today's head. Exit `1` means a decisive falsifier changed, a falsifier has no registered check or document-review route, or a runtime error; exit `2` means invalid usage.
- **Provider or extraction trouble:** inspect `providerUrls()`, `providerTransport()`, `fetchDocument()` and `documentText()` in `scripts/maintenance/verify-failure-scenarios.ts`; keep credentials private. Unavailable extraction is never an empty-text hash.
- **Interpret:** read [row verdicts](references/row-verdicts.md#row-verdicts) before classifying any falsifier, figure, observation or document row.
- **Refresh document baselines:** only after a human read the changed source and decided what it means; follow [deliberate refresh](references/row-verdicts.md#deliberate-document-baseline-refresh). A refresh is not approval and never edits the record.
- **Decide per coin:** `still holds`, `correct and re-approve`, `retire`, or `undecided: evidence gap`, per [maintainer decisions](references/row-verdicts.md#maintainer-decisions). Any edit to approved content withholds publication until maintainer re-approval.

## Checks Owned By The Verifier

After a document-baseline refresh: `npm run check:failure-scenarios` and `npx vitest run shared/lib/__tests__/failure-scenarios.test.ts scripts/maintenance/__tests__/verify-failure-scenarios.test.ts`. A plain re-read changes no tracked file.

## Completion Evidence

Deliver a per-coin decision table with supporting row IDs, the pins and pin mode, read provenance, every unavailable item with its exact gap, and the action owner. The report is advisory: the maintainer decides all record edits, re-approvals and retirements ([Monthly re-verification and falsifier suspension](../../../docs/process/failure-scenarios.md#monthly-re-verification-and-falsifier-suspension)).
