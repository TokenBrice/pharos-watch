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

## Recovered capture-time registries

The September 2026 replay repair recovered these registry identities by exporting
the Git tree, rebuilding its merged per-coin catalog, and recomputing the
generator's canonical active/frozen/dead registry SHA-256. These are verified
registry-equivalent commits, not a claim that the capture records a deployment
commit (it does not).

| Capture | Registry commit | Recomputed fingerprint |
| --- | --- | --- |
| `capture-20260904-1100.json` | `83ee5baede53181d2fc07fd43a7acd103f0f562f` | `4ab43dac582c76e86fd35c1d05f13ce9f9e3e81c3d02203b842ea12b96b68d38` |
| `capture-20260905-0620.envelope.json` | `a711d32b0e2ea21f562bc29e4f37d6d1a36ac35d` | `3b1fb40199248596da6fae4f4f292dd6f4eba5e7497a6fd3c79d430d2af5ef39` |

There is no committed pinned-captures manifest for these fixed-input exports;
the evaluation-build manifest's capture pins cover mechanism shock evidence,
not these operator captures.

Use those SHAs with replay's `--registry-ref`, at clocks `1788509806` and
`1788589087` respectively. Both completed with 337 cards, without either
mismatch/future-review override. Repeating each replay produced identical full
artifact bytes and `safety-score-v9:diff --assert-empty` printed
`EMPTY DIFF — bit-identical` for each. The September 5 embedded-snapshot export
also replayed without a ref and diffed empty against the ref-based replay.

The regression `replays a capture-time NAV asset that is non-NAV live only with
its verified registry snapshot` fails with the former live-only NAV validator
and passes with snapshot validation. The complete replay test file passed
12 tests. No vcred classification was changed and both captures retain its NAV
row with price `1.0022877855081067`.

### Identity limits

Both capture registry fingerprints and original base-input generation IDs
were preserved:

- September 4: `report-cards-input:v1:389d904739cfc13219c02e77b300dba1d6e87bef3e22e769062c1fbc47a38065`.
- September 5: `report-cards-input:v1:0b0838b3396f373da240128c58f51062cd94c9c6da41b35e539ad18e735fd7ac`.

Neither approved capture contains a production publication/result digest.
The September 5 envelope contains an **input** identity and payload checksum;
its `evaluationBuildDigest` is
`2ba546674fe51a6c484c9777ceec39ce9902291d877a128a5a3586cbe5af73cd`,
whereas the tested checkout's replay build digest was
`a0c0b82c4266cfda0412d18e50ddac65bdfe251fb8d0bbaaa1bc11d024931317`.
These do not match, nor should registry recovery pretend to restore evaluator
code, policy, and all other V9 overlays. The production envelope checksum is
verified during parsing; it is not a score-result checksum. Therefore these
runs prove capture-time registry/NAV interpretation and deterministic replay,
**not** historical production-output equivalence or a release authorization.
See the [equivalence harness](./safety-score-equivalence-harness.md#capture-time-registry-replay)
for snapshot scope and current-curation mode.

## Composite ceiling gate

`scripts/maintenance/check-safety-score-v9-composite-ceiling.ts` is the
operator-side A+ reachability gate. Given a replay artifact, it assembles the
best real, currently-measured pillar sub-scores per cohort (unrestricted,
non-wrapper, issuer-class) and asserts the resulting composite can still reach
A+. The donor composite is scored by the production aggregation seam
(`aggregateV9SmoothBoundedHeadroom` with the policy's single
`compensabilityHeadroom` — the same call the live formula makes), so the gate
certifies the real frontier rather than a historical hard-cap counterfactual.
Pillar-dependent headroom (the retired `controlCompensabilityHeadroom`
`legacy-control-selector` experiment) belongs only to
`scripts/maintenance/replay-safety-score-v9-aggregation.ts` and must not
re-enter the gate.
