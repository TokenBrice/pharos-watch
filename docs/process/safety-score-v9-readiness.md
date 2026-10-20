# Mechanism Capture Storage and Replay

This page owns raw mechanism-capture retention and exact-byte replay. Compact
summaries feed the shock-registry and evaluation-build generators; the scorer
consumes generated registry-backed facts. The stable filename is not a rollout status.

## Mechanism capture storage

Raw JSON captures are gzip-compressed and uploaded to the Cloudflare R2 bucket
`pharos-measurements` with keys under `captures/<mechanism>/<date>.json.gz`.
The `captures/` prefix has a 180-day lifecycle. Each capture's Git summary
stores its mechanism, date, SHA-256, uncompressed byte count, R2 key, and every
field needed by the score registry or replay attestation.

The evaluation-build manifest records the SHA-256 and `captures/` key of the latest
shock summary per mechanism by block timestamp, not by scoring eligibility. The uploader
mirrors referenced/latest shock objects under `pinned/`, the durable replay path.
R2 lifecycle is external account policy. Upload requires `R2_MEASUREMENTS_ACCESS_KEY_ID`,
`R2_MEASUREMENTS_SECRET_ACCESS_KEY`, and `CLOUDFLARE_ACCOUNT_ID`.

## Replay and expiry

Replay resolution first returns an existing requested local raw file unchanged,
before reading a summary or comparing its SHA-256. Local raw bytes therefore
take precedence over the cache and R2; this resolver does not attest them.
Downstream replay/attestation validation is a separate boundary.

Only when the requested raw path is absent does summary-backed resolution:

1. read the companion summary, then check `agents/.cache/measurements/<sha256>.json`
   and verify its SHA-256;
2. try the pinned R2 key derived from the summary's `captures/` key;
3. try the lifecycle-managed `captures/` object if the pinned object is absent;
4. decompress the fetched body, verify the summary SHA-256, and write verified
   bytes to the local cache. An integrity mismatch fails closed, not over to
   another source.

A missing or expired object is not regenerated, approximated, or silently
skipped. The exact terminal error is:

```text
capture <sha256> expired: non-replayable
```

An attestation may continue to project a previously verified capture after its
raw body leaves `captures/`, but a new replay or an integrity mismatch fails
closed. Registries and attestations therefore remain byte-stable while the raw
retention policy is enforced.

Protocol-API collection and reviewed weekly automation are permanent non-publishing evidence tooling. Strict replay distinguishes canonical raw-byte V2, the exact hash-verified normalized-only V1 exception, and unavailable evidence. Recognizing the frozen V1 hash in summary metadata does not verify its original bytes. Absent/corrupt bodies fail `--replay` and `--replay-all`; missing account/access fails when replay needs R2 rather than local original bytes or verified cache. No unavailable V2 counts as V1 or as a passed replay. Network-free verification requires local original bytes or verified cache; otherwise signed R2 reads and a cache write occur. Original-byte hash readback is required before claiming preservation.

## Test-owned replay fixtures

Original capture bodies used by offline replay live in
`scripts/__tests__/fixtures/<assetId>-mechanism-measurement-block-<number>.json`.
Their immutable recovery source is `ade03b84b^:shared/data/safety-score-v9/mechanism-measurements/<assetId>/<date>.json`.
`scripts/__tests__/measure-cdp-mechanism-metrics.test.ts` checks SHA-256 and byte
count against committed summaries before family replay; edited or regenerated
fixtures are not replacement evidence.

Offline call descriptors author only canonical function signatures; the journals
derive and memoize selectors at encoding time. Captured selector/calldata bytes,
request order, decoded values and exhaustion checks remain independent replay
assertions. Keep the frozen family replay code and original fixtures even when
unused authoring conveniences are removed.

The frozen `scripts/__tests__/fixtures/usde-ethena-frozen-legacy-protocol-api-v1.json`
is accepted only at its designated capture path and pinned SHA-256 by the protocol-API
replay tests. Identical bytes under another capture name do not qualify.

## Recovered capture-time registries

These registry-equivalent Git commits recover the canonical active/frozen/dead
registry fingerprint for each capture. A registry match does not identify the
deployed evaluator revision.

| Capture | Registry commit | Recomputed fingerprint |
| --- | --- | --- |
| `capture-20260904-1100.json` | `83ee5baede53181d2fc07fd43a7acd103f0f562f` | `4ab43dac582c76e86fd35c1d05f13ce9f9e3e81c3d02203b842ea12b96b68d38` |
| `capture-20260905-0620.envelope.json` | `a711d32b0e2ea21f562bc29e4f37d6d1a36ac35d` | `3b1fb40199248596da6fae4f4f292dd6f4eba5e7497a6fd3c79d430d2af5ef39` |

Use `--registry-ref` with the listed commit and clocks `1788509806` and
`1788589087`, respectively. The September 5 envelope also carries its registry
snapshot. These fixed-input exports have no committed pinned-captures manifest:
evaluation-build capture pins cover mechanism shock evidence, not operator captures.

### Identity limits

Registry recovery supports capture-time registry/NAV interpretation and deterministic
replay, not historical production-output equivalence or release authorization.
Neither listed capture contains a production result digest. An envelope's input
identity/checksum verifies its input, not scored output; registry recovery restores
neither evaluator code nor policy/other overlays. Use the
[capture-time registry replay contract](./safety-score-equivalence-harness.md#capture-time-registry-replay)
for trusted-ref/snapshot scope and current-curation mode.

## Composite ceiling policy

No separate composite ceiling is applied today, and there is no operator-side
A+ reachability gate. V9 uses the production smooth-bounded-headroom
aggregation with `semantic.formula.compensabilityHeadroom`; evidence ceilings
and structural caps remain the scoped constraints documented in
[report cards](report-cards-appendix.md#cap-limits-and-scope-gates).
