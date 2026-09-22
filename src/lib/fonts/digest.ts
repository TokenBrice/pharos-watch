import localFont from "next/font/local";

export const digestDisplay = localFont({
  src: [
    { path: "../../assets/fonts/Newsreader-Variable.subset.woff2", weight: "200 800", style: "normal" },
    { path: "../../assets/fonts/Newsreader-Italic-Variable.subset.woff2", weight: "200 800", style: "italic" },
  ],
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
  // Lazy: Newsreader is mounted by the digest archive preview and dated digest
  // pages. preload: false keeps it off routes without a digest surface.
  preload: false,
});
