# Agent Task Router

Use this page to enter the documentation corpus without loading unrelated reference material.

The machine-readable routing source of truth is [doc-ownership.json](./doc-ownership.json). It maps source areas to the docs, checks, and hard rules that apply to a change. Do not maintain a second task-family inventory in this file.

## Route A Task

From the repository root, run:

```bash
node scripts/ci/pharos-change-contract.mjs --markdown
```

Use `--staged` when the intended change is staged but not committed. The command reports:

- matched task families and risk
- changed source files
- the smallest useful docs set
- docs that may need updates
- focused checks and hard rules

Then:

1. Read only the reported docs. For large docs with an `Agent navigation` block, Grep or offset-read the matched section.
2. Inspect the reported source entrypoints and follow local imports only as needed.
3. Treat code, schemas, registries, and checked runtime data as authoritative when prose disagrees.
4. Update the nearest owning doc only when behavior, API contracts, methodology, operations, or data-source policy changed.

## When Routing Misses

Search by source path or product term:

```bash
rg -n 'source/path|product term' docs docs/doc-ownership.json
rg --files docs | sort
```

Use [README.md](./README.md) to choose between public reference, engineering contracts, process guidance, and runbooks. If a recurring source area is not classified correctly, update `doc-ownership.json` and the change-contract tests instead of expanding this page.

## Methodology Changes

Methodology history is structured under `shared/data/methodology-changelogs/` and rendered by the public `/methodology/*-changelog/` routes. Update the owning methodology document, structured changelog entry, and `/methodology` section when behavior changes. Do not create a second Markdown timeline.
