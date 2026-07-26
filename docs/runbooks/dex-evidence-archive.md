# DEX Evidence Archive

## Scope

The archive moves completed, no-longer-live DEX generation evidence from D1 to a private Standard R2 bucket. It is a cold recovery and audit surface only. Normal API reads, scoring, DEX producers, status UI reads, and browser code never download or list R2 objects.

The production binding is `EVIDENCE_ARCHIVE`; preview/local work uses the configured preview bucket. Production objects live under `dex/`, expire through the 35-day R2 lifecycle rule, and carry a 30-day logical expiry in D1. Verified manifest evidence remains for 90 days after source deletion.

## Rollout modes

- `DEX_MEASURED_ARCHIVE_MODE=off|shadow|delete`
- `DEX_LIQUIDITY_ARCHIVE_MODE=off|shadow|delete`

Invalid values fail closed to effective `off` and surface a configuration error. `off` retains the existing D1 cleanup behavior. `shadow` permits create-only upload and full download verification; cleanup may delete only generations with verified manifests. `delete` lets the isolated archive job own early deletion after the three-hour hot window while producer retention remains a fallback.

Release A is hard-gated to effective `off` even if either variable is changed. It records only family state and `cron_runs` evidence; source selection and R2 I/O do not exist on that release path.

## Schedule and budgets

`archive-dex-generations` runs at `19,49 * * * *` under its own lease, slot fence, timeout, and status row. R2 work is sequential with a declared `1/6` connection budget. One invocation processes at most 12 objects, performs at most six minutes of archive work, and starts no new object with less than 60 seconds remaining.

Each immutable object is one canonical JSON generation compressed with gzip. SHA-256 covers the uncompressed canonical bytes and is stored in both the manifest and object custom metadata. The uncompressed cap is 32 MiB; oversize generations stay in D1 and degrade archive status pending a separately designed multipart format.

## Safety invariants

- Upload, download, decompression, exact schema/count/byte/hash verification, and a verified manifest must all succeed before source deletion is eligible.
- Create-only writes never overwrite an existing deterministic key. An existing mismatch is corrupt evidence, degrades the job, and leaves D1 untouched.
- Archive failure can delay cleanup but cannot delete the sole verified copy.
- Measured quotes and their exact target dependency closure archive first. Current, incomplete, candidate/writing, younger-than-three-hour, referenced, or count-mismatched generations remain in D1.
- Liquidity eligibility additionally requires a successful `sync-dex-liquidity` run whose `metadata.persistence.generationId` matches, proving challenger, price, history, and depth completion.
- D1 deletion and `source_deleted_at` advancement occur in one D1 batch after a final reference/eligibility recheck.

## Rollback

Set both modes to `off` and deploy the prior Worker. Keep the binding, bucket, objects, manifests, and family state for forensic evidence. A Worker rollback does not recreate already deleted D1 rows.

If the 24-hour physical growth slope remains above 200 MB/day for six hours or conservative runway remains below 14 days for six hours, use the separately reviewed emergency release that reduces DEX D1 retention to 24 hours. Do not silently broaden archive eligibility.

## Required release evidence

- Foundation: migration active, exactly 22 triggers, archive lane `1/6`, repeated no-op runs with zero source changes and zero R2 objects.
- Measured shadow: at least 48 hours of exact round trips, idempotent retry evidence, protected-generation tests, backlog under two hours, and healthy memory/duration.
- Measured delete: inspect the first exact deletion, product/scoring health, then observe 72 hours before changing liquidity.
- Liquidity shadow: at least 48 hours with downstream completion and public-reference fences proven.
- Liquidity delete: inspect the first exact deletion, then observe both families for seven clean days.
- Completion: 72-hour D1 growth at or below 20 MB/day, conservative runway above 180 days, archive backlog below two hours, no normal R2 read path, and a successful bounded restore drill.
