import localFont from "next/font/local";

export const digestDisplay = localFont({
  src: [
    { path: "../../assets/fonts/Newsreader-Variable.subset.woff2", weight: "200 800", style: "normal" },
    { path: "../../assets/fonts/Newsreader-Italic-Variable.subset.woff2", weight: "200 800", style: "italic" },
  ],
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
  // Lazy: Newsreader is only mounted under <DailyDigest> (dynamic on the
  // homepage and statically on /digest/*). preload: false keeps it off the
  // critical fetch list for routes that don't render the digest surface.
  preload: false,
});
