export interface MediaAppearance {
  host: string;
  hostLogoSrc: string;
  title: string;
  description: string;
  href: string;
  /** ISO date of the broadcast or publication. */
  date: string;
  featured?: boolean;
}

// Kept in its own module rather than in `about-content.ts` so the homepage
// "Seen on" strip can read it without pulling the about page's large
// data-source prose into that route.
export const MEDIA_APPEARANCES: readonly MediaAppearance[] = [
  {
    host: "Ethereum Foundation",
    hostLogoSrc: "/media/ethereum-foundation.jpg",
    title: "Ethereum Builders Live: Pharos",
    description:
      "The Ethereum Foundation hosted TokenBrice and chaskin.eth to explore what makes a stablecoin trustless, walk through the Pharos risk dashboard, and dig into stablecoin analytics.",
    href: "https://x.com/i/broadcasts/1AGRnZPeoeaGl",
    date: "2026-08-18",
    featured: true,
  },
  {
    host: "DeFi Dad",
    hostLogoSrc: "/media/defi-dad.jpg",
    title: "Don't Touch A Stablecoin Without Checking Pharos First",
    description: "A DeFi Frontier episode on using Pharos to vet a stablecoin before putting money behind it.",
    href: "https://www.youtube.com/watch?v=IYgAPNvYXs0",
    date: "2026-08-19",
  },
  {
    host: "Leviathan News",
    hostLogoSrc: "/media/leviathan-news.jpg",
    title: "How Stable Is Your Stablecoin?",
    description:
      "TokenBrice walked through Pharos live — the motivation behind the project, the data pipeline, and how the main risk signals should be read in practice.",
    href: "https://www.youtube.com/watch?v=n2qDkuZl3AA",
    date: "2026-03-03",
  },
];
