import { StartHerePage } from "@/components/start-here-page";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata = buildPageMetadata({
  title: "Start Here: How to Use Pharos",
  description:
    "New to Pharos? Learn what the main stablecoin signals mean, choose the right feature for your goal, and find the fastest path into market monitoring, research, yield, and alerts.",
  canonical: "/start/",
});

export default function StartPage() {
  return <StartHerePage />;
}
