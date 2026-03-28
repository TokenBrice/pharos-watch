import localFont from "next/font/local";

export const geistSans = localFont({
  src: [
    { path: "../../public/fonts/Geist-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../public/fonts/Geist-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-geist-sans",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const geistMono = localFont({
  src: [{ path: "../../public/fonts/GeistMono-Regular.ttf", weight: "400", style: "normal" }],
  variable: "--font-geist-mono",
  display: "swap",
  fallback: ["SFMono-Regular", "ui-monospace", "monospace"],
});

export const digestDisplay = localFont({
  src: [
    { path: "../../public/fonts/Newsreader-Variable.ttf", weight: "200 800", style: "normal" },
    { path: "../../public/fonts/Newsreader-Italic-Variable.ttf", weight: "200 800", style: "italic" },
  ],
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});
