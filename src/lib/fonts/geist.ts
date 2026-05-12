import localFont from "next/font/local";

export const geistSans = localFont({
  src: [
    { path: "../../assets/fonts/Geist-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../assets/fonts/Geist-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-geist-sans",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const geistMono = localFont({
  src: [{ path: "../../assets/fonts/GeistMono-Regular.ttf", weight: "400", style: "normal" }],
  variable: "--font-geist-mono",
  display: "swap",
  fallback: ["SFMono-Regular", "ui-monospace", "monospace"],
});
