# Hotspot Waiver Backlog

`scripts/lib/hotspot-ratchet-waivers.json` is the source of truth for the hotspot decomposition backlog. Each waiver entry must keep `disposition`, `owner`, `createdAt`, `reviewAfter`, and `nextAction` current; do not copy the full waiver table into docs.

Use this export when planning a maintenance tranche:

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; const waivers = JSON.parse(readFileSync("scripts/lib/hotspot-ratchet-waivers.json", "utf8")); console.log(["reviewAfter", "owner", "file", "nextAction"].join("\t")); for (const [file, waiver] of Object.entries(waivers).sort((a, b) => a[1].reviewAfter.localeCompare(b[1].reviewAfter) || a[0].localeCompare(b[0]))) console.log([waiver.reviewAfter, waiver.owner, file, waiver.nextAction].join("\t"));'
```

Backlog handling:

- Sort by `reviewAfter`, current hotspot size, and recent change frequency.
- Convert the selected `nextAction` into the owning maintenance issue or internal work item before starting a refactor.
- When a waived file is touched, either shrink the hotspot and update the ratchet baseline after review, or update `notes`, `reviewAfter`, and `nextAction` with the dated reason the file did not shrink.
- Do not add a blocking shrink-or-justify check until the allowed justification format is agreed and covered by tests.

Validation remains `npm run check:hotspot-ratchet`; it already fails stale, missing, or due waiver metadata and prints upcoming reviews.
