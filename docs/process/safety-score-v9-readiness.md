# Safety Score V9 Readiness

This page records the operational readiness contract for score-bearing mechanism
captures. The score evaluator consumes committed compact summaries and generated
registries; raw capture bodies are retained outside Git for replay.

## Mechanism capture storage

Raw JSON captures are gzip-compressed and uploaded to the Cloudflare R2 bucket
`pharos-measurements` with keys under `captures/<mechanism>/<date>.json.gz`.
The `captures/` prefix has a 180-day lifecycle. Each capture's Git summary
stores its mechanism, date, SHA-256, uncompressed byte count, R2 key, and every
field needed by the score registry or replay attestation.

The evaluation-build manifest pins the latest score-bearing shock capture for
each mechanism under `pinned/<mechanism>/<date>.json.gz`. The `pinned/` prefix
has no lifecycle policy and is the durable replay path. The uploader uses the
R2 credentials `R2_MEASUREMENTS_ACCESS_KEY_ID` and
`R2_MEASUREMENTS_SECRET_ACCESS_KEY` together with `CLOUDFLARE_ACCOUNT_ID`.

## Replay and expiry

Replay resolution is deterministic and fail-closed:

1. check `agents/.cache/measurements/<sha256>.json` and verify its SHA-256;
2. fetch the pinned R2 object, if the summary identifies one;
3. fetch the lifecycle-managed `captures/` object;
4. decompress, verify the summary SHA-256, and write the verified bytes to the
   local cache.

A missing or expired object is not regenerated, approximated, or silently
skipped. The exact terminal error is:

```text
capture <sha256> expired: non-replayable
```

An attestation may continue to project a previously verified capture after its
raw body leaves `captures/`, but a new replay or an integrity mismatch fails
closed. Registries and attestations therefore remain byte-stable while the raw
retention policy is enforced.
