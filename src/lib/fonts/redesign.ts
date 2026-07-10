import localFont from "next/font/local";

// JetBrains Mono — the data/figures face from the Figma redesign. Self-hosted
// variable woff2 (OFL). Exposed as --font-jetbrains-mono and folded into
// --font-geist-mono (see globals.css .pharos-font-mono) so every existing mono
// consumer (.pharos-numeric, tables, peg-hero) inherits it.
export const jetbrainsMono = localFont({
  src: [{ path: "../../assets/fonts/JetBrainsMono-Variable.woff2", weight: "100 800", style: "normal" }],
  display: "swap",
  variable: "--font-jetbrains-mono",
  fallback: ["SFMono-Regular", "ui-monospace", "Menlo", "Monaco", "Consolas", "Liberation Mono", "monospace"],
});

// Bricolage Grotesque is the tracked display face. Licensed ABC Whyte files can
// still be staged locally, but clean builds never emit references to them.
export const bricolageDisplay = localFont({
  src: [{ path: "../../assets/fonts/BricolageGrotesque-Variable.woff2", weight: "200 800", style: "normal" }],
  display: "swap",
  variable: "--font-bricolage",
  fallback: ["system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
});
