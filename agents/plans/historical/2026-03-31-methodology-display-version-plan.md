# Methodology Display Version Plan

## Goal

Make methodology version numbers monotonic to a normal decimal reader so labels like `v2.10` no longer appear numerically "below" `v2.9`.

## Approach

1. Renumber the canonical methodology histories directly in the shared version-source files.
2. Keep the numbering scheme simple: after `.9`, roll to the next major (`2.10 -> 3.0`, `2.19 -> 3.9`).
3. Resolve any cross-series collisions in the same methodology by continuing the sequence upward (for example Yield `v4.10 -> v5.0`, `v4.11 -> v5.1`, `v5.0 -> v5.2`).
4. Update the matching methodology docs and timeline docs to the new canonical numbers.
5. Run the relevant tests and validation commands.
