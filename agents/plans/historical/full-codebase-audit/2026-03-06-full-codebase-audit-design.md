# Full-Scale Codebase Audit — Design Document

## Problem

Pharos has grown organically over months of rapid feature development. After the recent ticker-issuer ID migration, the codebase has never had a comprehensive quality audit. Issues likely exist across all layers: stale documentation, accessibility gaps, missing SEO metadata, untested edge cases, data integrity risks, and security blind spots. Without a systematic audit, these issues accumulate as technical debt and production risk.

## Goal

Produce a single actionable audit report (`docs/audit/2026-03-06-full-codebase-audit.md`) covering every layer of the Pharos codebase and live deployment. Each finding is classified by severity (4-tier), effort-estimated, and specific enough to convert directly into implementation tickets.

## Scope

### What's being audited

| Layer | Scope | Approximate Size |
|-------|-------|-----------------|
| Frontend | 27 pages, 292 source files, 36 tests | `src/` |
| Worker | ~19 cron jobs, ~45 API handlers, ~60 test files, 50 migrations | `worker/` |
| Shared | Runtime-neutral modules, 1 test | `shared/` |
| Documentation | 75+ markdown files | `docs/` |
| Live deployment | pharos.watch + api.pharos.watch | Production |

### Audit domains

10 parallel domains, each producing an independent findings file:

| # | Domain | Scope |
|---|--------|-------|
| 1 | Documentation | Accuracy vs code, stale paths, wrong counts, phantom references, missing docs for features |
| 2 | Frontend: UI/UX | Component consistency, error/loading states, responsive design, design token compliance, dead code |
| 3 | Frontend: Accessibility | ARIA attributes, keyboard nav, contrast, screen reader support, form labels, focus management |
| 4 | Frontend: SEO & Meta | Meta/OG tags, canonicals, structured data, sitemap, robots.txt, page titles. Live probes. |
| 5 | API Correctness | Response shapes vs docs, error handling, edge cases, cache headers, CORS. Live probes. |
| 6 | Cron Jobs & Data Pipeline | Error handling, connection pools, timeouts, data integrity guardrails, staleness detection |
| 7 | Schema & Data Integrity | D1 schema, indexes, query risks, type mismatches DB-to-API-to-frontend |
| 8 | Testing Coverage | Gaps, edge case coverage, assertion quality, mock correctness, flaky patterns |
| 9 | Security (light touch) | Auth bypass, input validation, SQL injection, XSS, CORS misconfig, dependency vulnerabilities |
| 10 | Status & Observability | `/status` accuracy, self-check coverage, alert gaps, monitoring blind spots |

### What's NOT in scope

- Full penetration testing or threat modeling
- Performance benchmarking or load testing
- Code changes or fixes (findings only)
- Infrastructure audit (Cloudflare config, DNS, WAF rules)

## Report Schema

### Finding format

Each finding follows this template:

```
- [DOMAIN-NNN] **Title** — Description of the issue, where it occurs
  (`file:line` or URL), why it matters, and what the fix looks like. `[~effort]`
```

### Severity levels

| Severity | Definition | Examples |
|----------|-----------|---------|
| **Critical** | Production risk, data loss, security vulnerability | Silent data corruption, auth bypass, broken cron with no alerting |
| **High** | Correctness issue, wrong behavior | API returns wrong shape, doc describes non-existent endpoint, missing error handling causing 500s |
| **Medium** | Quality/maintainability concern | Inconsistent component patterns, missing tests for important logic, stale docs |
| **Low** | Cosmetic, nice-to-have | Typos in docs, unused imports, minor style inconsistencies |

### Effort estimates

| Tag | Meaning |
|-----|---------|
| `[~30m]` | Quick fix, single file |
| `[~1h]` | Small change, 1-2 files |
| `[~2h]` | Moderate change, 2-4 files |
| `[~4h]` | Half-day task |
| `[~1d]` | Full day |
| `[~2-3d]` | Multi-day effort |
| `[~1w]` | Week-long project |

### Final report structure

```
# Pharos Full Codebase Audit — 2026-03-06

## Executive Summary
- Total findings: N (X critical, Y high, Z medium, W low)
- Health summary per domain (one-line verdict each)

## Findings by Domain
### 1. Documentation
#### Critical
- [DOC-001] ...
#### High
- [DOC-002] ...
(repeat for all 10 domains)

## Cross-Cutting Concerns
(issues spanning multiple domains)

## Appendix
- Audit methodology
- Files examined per domain
```

## Existing Prior Work

A documentation-focused audit was completed on 2026-03-05 (`docs/documentation-audit-report-2026-03-05.md`). Domain 1 (Documentation) should reference this report, verify its findings were addressed, and focus on gaps it missed.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Codex agents lack internet access for live probes | Include curl commands in tickets. If they fail, orchestrator runs them manually and appends results to the findings file before consolidation. |
| Agents produce inconsistent finding formats | Strict template with examples in every ticket. Consolidation ticket normalizes any deviations. |
| Duplicate findings across domains | Consolidation phase explicitly deduplicates. Domain tickets include scope boundaries to minimize overlap. |
| Agents miss issues due to limited context window | Each ticket focuses on specific files and checks. Breadth of coverage over depth on individual files. |
| False positives inflate the report | Orchestrator reviews each findings file before consolidation. Unverified findings are tagged `[unverified]`. |
| Stale line numbers in tickets | Tickets reference file paths and function/component names rather than pinning to exact line numbers. |
