# Pre-Cliff Baseline Sealed Run Log

Unhashed operational log for recording immutable validation archive seals produced under [Pre-Cliff MiCA / GENIUS Baseline & Rolling Validation Archive](./pre-cliff-baseline.md). Keeping sealed run receipts out of `docs/process/pre-cliff-baseline.md` ensures recording a manifest SHA never invalidates the pre-registered `designSha256`.

## Sealed Baseline Summary (Pending December 2026 Seal)

| Field | Value at seal |
| --- | --- |
| `capturedAt` | _pending December 2026 seal_ |
| `apiBase` | `https://api.pharos.watch` |
| `capturedDate` / `baselineDate` | _pending_ |
| `gitSha` | _pending_ |
| `designSha256` (`git show <gitSha>:docs/process/pre-cliff-baseline.md \| sha256sum`) | _pending_ |
| Manifest `r2Key` | `pinned/validation/pre-cliff-2026-12/manifest.json` |
| Manifest SHA-256 | _pending_ |
| `partial` | _pending (`false` required for canonical seal)_ |
| Archived object count | _pending_ |
| Active MiCA cohorts (`auth / pend / non-comp / oos / unass`) | _pending (`c4ec79a08`: 14 / 1 / 34 / 177 / 117)_ |
| Active GENIUS cohorts (`intent / no-auth / n-a / unk / unass`) | _pending (`c4ec79a08`: 19 / 138 / 122 / 6 / 58)_ |
| `verify` pass timestamp | _pending_ |
