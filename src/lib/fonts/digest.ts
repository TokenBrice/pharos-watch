import localFont from "next/font/local";

export const digestDisplay = localFont({
  src: [
    { path: "../../assets/fonts/Newsreader-Variable.ttf", weight: "200 800", style: "normal" },
    { path: "../../assets/fonts/Newsreader-Italic-Variable.ttf", weight: "200 800", style: "italic" },
  ],
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});
