# Font Assets

How the self-hosted webfonts under `src/assets/fonts/` are produced and staged. Which faces Pharos uses, and why, is design intent and lives in [Design Language: Context](../design-language.md#context); this page owns the production, licensing, and drift constraints.

## Tracked Faces

| Face | Source | Produced by |
| --- | --- | --- |
| Geist, Geist Mono | TTFs in `src/assets/fonts/originals/` | `npm run subset:fonts` — TTF→woff2 conversion, all glyphs retained, hinting removed |
| Newsreader (roman + italic variable) | TTFs in `src/assets/fonts/originals/` | `npm run subset:fonts` — subsetted against `data/fonts/glyphs-allowlist.txt`, `wght 200..800` preserved |
| Bricolage Grotesque, JetBrains Mono | committed woff2, no tracked original | none — there is no regeneration path; replace the woff2 by hand |
| Social-card instances (static TTF) | the four faces above | `npm run subset:fonts -- --social-card` — see [Social-card instances](#social-card-instances) |

Runtime loaders are `src/lib/fonts/digest.ts` and `src/lib/fonts/redesign.ts`; `src/lib/fonts/geist.ts` exposes legacy variable names only. The Worker bundles no Geist: its only fonts are the social-card instances in `worker/assets/fonts/social-card/`, an output of this pipeline.

## Social-card instances

Social previews and the dated scorecard (`shared/lib/social-card/`, [OG Images](../og-images.md)) draw with the site's own faces. Satori and resvg cannot read woff2 and render a variable font at its default instance whatever `font-weight` asks for, so `worker/assets/fonts/social-card/` holds static TTF instances that the Node renderer (`scripts/lib/social-card-render.ts`) reads. The Worker's dated scorecard (`worker/src/lib/og-fonts.ts`) bundles the same bytes for the four faces it draws: Bricolage 800 and 600, JetBrains Mono 500 and 700 (about 118 KB); it has no serif.

| File | Source | Instance |
| --- | --- | --- |
| `BricolageGrotesque-800.ttf`, `-600.ttf`, `-400.ttf` | `src/assets/fonts/BricolageGrotesque-Variable.woff2` (the 96pt optical cut) | `wght` 800 / 600 / 400 |
| `JetBrainsMono-500.ttf`, `-700.ttf` | `src/assets/fonts/JetBrainsMono-Variable.woff2` | `wght` 500 / 700; `calt` removed so code ligatures never fuse tickers such as `USD0++` |
| `Newsreader-72pt-500.ttf` | `originals/Newsreader-Variable.ttf` | `wght` 500, `opsz` 72 |
| `Newsreader-72pt-Italic-400.ttf` | `originals/Newsreader-Italic-Variable.ttf` | `wght` 400, `opsz` 72 |

Each instance is subset to the drawable range — ASCII, Latin-1, `– ‘ ’ “ ” …` and `€` — with hinting removed and every other layout feature kept. The range must stay equal to the renderer's glyph check (`drawable()` in `shared/lib/social-card/tokens.ts`), which rejects any character outside it before Satori could substitute a fallback glyph; Bricolage has no `¤` or soft hyphen, so the check excludes both.

`--social-card` needs `python3` with fontTools and brotli (for the woff2 sources). It pins the instance, the subset and the name records and keeps the source timestamps, so a rerun on unchanged sources is byte-identical; diffing a rerun is the drift check, since `--check` does not open these files. Their bytes are part of every rendered card's identity, so regenerate them only with a source change and commit them together.

All three families are under the SIL Open Font License 1.1. Their upstream `OFL.txt` files and the fonts' name tables declare no Reserved Font Name (checked 2026-11-17), so the instances keep the upstream family names with an instance suffix ("Bricolage Grotesque 96pt", "JetBrains Mono", "Newsreader 72pt"). Newsreader's name table also carries a trademark notice (name ID 7), which is kept. If a future upstream release declares a Reserved Font Name, rename the instance families before regenerating.

## Regenerating (`npm run subset:fonts`)

Requires `pyftsubset` (fontTools) on PATH; the command exits `127` with install guidance when it is missing. CI never needs it. The Newsreader subset is driven entirely by `data/fonts/glyphs-allowlist.txt`, whose entries are single codepoints or inclusive ranges (`U+0041`, `U+0020-007E`); a malformed or empty allowlist aborts the run rather than shipping a degraded subset.

## What `--check` Does Not Cover

`npm run subset:fonts -- --check` is structural only: the five pipeline-produced woff2 files (Geist Regular, Geist Bold, Geist Mono Regular, Newsreader roman, and Newsreader italic) must exist, parse through fontTools (so `--check` needs Python with `fontTools` importable), carry a `cmap`, and — for the Newsreader subsets — retain a `wght` axis spanning `200..800` and a non-trivial glyph count. It does not open the manually supplied Bricolage Grotesque or JetBrains Mono files, so it cannot certify those runtime faces. It deliberately does not compare bytes, because pyftsubset's woff2 compressor is not deterministic across runs, so a byte comparison would never pass.

Two gaps follow from that, and both need operator discipline:

- `--check` does not verify that the committed subset matches the current allowlist or that the allowlist covers every glyph a digest headline can mount. Review new headline codepoints against the allowlist; editing the allowlist means re-running `npm run subset:fonts` and committing the output in the same change.
- Nothing runs `--check` automatically. It is not registered with `check:generated-artifacts` and no workflow calls it, so it catches drift only when an operator runs it deliberately.

## Licensed Whyte Webfonts (`npm run install:whyte-fonts`)

`npm run install:whyte-fonts -- /path/to/dinamo-order.zip` extracts the ABC Whyte Inktrap woff2 entries named in `scripts/maintenance/install-whyte-fonts.ts` into `public/fonts/abc-whyte-inktrap/`. It needs `unzip` on PATH and exits nonzero on a missing zip or entry. Extraction is incremental: a later missing entry leaves earlier extracted files in place.

The Dinamo license permits WOFF2 `@font-face` on the licensed domain but not the font files in a public repository, so the output directory is gitignored and this command stages local files only. Staging the files does not enable them: the production display face stays the tracked Bricolage Grotesque face in `src/lib/fonts/redesign.ts`, and a clean build emits no reference to Whyte. Switching to Whyte would require a deploy that provisions the files on the serving origin as well as a CSS change.
