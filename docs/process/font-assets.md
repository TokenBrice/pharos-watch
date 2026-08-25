# Font Assets

How the self-hosted webfonts under `src/assets/fonts/` are produced and staged. Which faces Pharos uses, and why, is design intent and lives in [design-context.md](../design-context.md); this page owns the production, licensing, and drift constraints.

## Tracked Faces

| Face | Source | Produced by |
| --- | --- | --- |
| Geist, Geist Mono | TTFs in `src/assets/fonts/originals/` | `npm run subset:fonts` — format-only TTF→woff2 conversion, all glyphs retained |
| Newsreader (roman + italic variable) | TTFs in `src/assets/fonts/originals/` | `npm run subset:fonts` — subsetted against `data/fonts/glyphs-allowlist.txt`, `wght 200..800` preserved |
| Bricolage Grotesque, JetBrains Mono | committed woff2, no tracked original | none — there is no regeneration path; replace the woff2 by hand |

Runtime loaders are `src/lib/fonts/digest.ts` and `src/lib/fonts/redesign.ts`; `src/lib/fonts/geist.ts` exposes legacy variable names only. `worker/assets/fonts/` keeps its own TTF copies because the OG renderer (Satori) needs raw TTF — it is not an output of this pipeline.

## Regenerating (`npm run subset:fonts`)

Requires `pyftsubset` (fontTools) on PATH; the command exits `127` with install guidance when it is missing. CI never needs it. The Newsreader subset is driven entirely by `data/fonts/glyphs-allowlist.txt`, whose entries are single codepoints or inclusive ranges (`U+0041`, `U+0020-007E`); a malformed or empty allowlist aborts the run rather than shipping a degraded subset.

## What `--check` Does Not Cover

`npm run subset:fonts -- --check` is structural only: each committed woff2 exists, parses through fontTools (so `--check` needs Python with `fontTools` importable), carries a `cmap`, and — for the Newsreader subsets — retains a `wght` axis spanning `200..800` and a non-trivial glyph count. It deliberately does not compare bytes, because pyftsubset's woff2 compressor is not deterministic across runs, so a byte comparison would never pass.

Two gaps follow from that, and both need operator discipline:

- `--check` does not verify that the committed subset matches the current allowlist. `src/lib/fonts/__tests__/digest-glyph-allowlist.test.ts` guards the other direction — every glyph a digest headline can mount is inside the allowlist — so adding a codepoint keeps both checks green until the woff2 is regenerated. Editing the allowlist means re-running `npm run subset:fonts` and committing the output in the same change.
- Nothing runs `--check` automatically. It is not registered with `check:generated-artifacts` and no workflow calls it, so it catches drift only when an operator runs it deliberately.

## Licensed Whyte Webfonts (`npm run install:whyte-fonts`)

`npm run install:whyte-fonts -- /path/to/dinamo-order.zip` extracts the ABC Whyte Inktrap woff2 entries named in `scripts/maintenance/install-whyte-fonts.ts` into `public/fonts/abc-whyte-inktrap/`. It needs `unzip` on PATH and fails closed on a missing zip or a missing entry.

The Dinamo license permits WOFF2 `@font-face` on the licensed domain but not the font files in a public repository, so the output directory is gitignored and this command stages local files only. Staging the files does not enable them: the production display face stays the tracked Bricolage Grotesque face in `src/lib/fonts/redesign.ts`, and a clean build emits no reference to Whyte. Switching to Whyte would require a deploy that provisions the files on the serving origin as well as a CSS change.
