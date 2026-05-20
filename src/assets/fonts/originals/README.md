# Font Originals

Source TTFs kept here for the `subset:fonts` maintenance script. These files are
not loaded by the app at runtime — `src/lib/fonts/{geist,digest}.ts` reference
the generated `.woff2` files in `src/assets/fonts/`.

Do not delete. Regenerate woff2 with `npm run subset:fonts`.

## Upstream sources

| File | Upstream |
| --- | --- |
| `Geist-Regular.ttf` | https://github.com/vercel/geist-font (SIL Open Font License) |
| `Geist-Bold.ttf` | https://github.com/vercel/geist-font (SIL Open Font License) |
| `GeistMono-Regular.ttf` | https://github.com/vercel/geist-font (SIL Open Font License) |
| `Newsreader-Variable.ttf` | https://github.com/productiontype/Newsreader (SIL Open Font License) |
| `Newsreader-Italic-Variable.ttf` | https://github.com/productiontype/Newsreader (SIL Open Font License) |

`worker/assets/fonts/` keeps its own TTF copies for the OG renderer (Satori
needs raw TTF). Do not touch those.
