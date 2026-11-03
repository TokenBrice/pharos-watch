import Link from "next/link";

import { API_PARTNERS } from "@/lib/api-partners";
import { formatProseList } from "@shared/lib/format";

// The API's line in the homepage tail, beside the "Seen on" strip from lg up.
// Static content only: /api/ owns the offers and the full partner row.
export function HomeApiStrip(): React.JSX.Element {
  const names = API_PARTNERS.map((partner) => partner.name);

  return (
    <section aria-labelledby="home-api-strip-title" className="lg:shrink-0">
      <h2 id="home-api-strip-title" className="sr-only">
        Pharos API
      </h2>
      <Link
        href="/api/"
        prefetch={false}
        className="pharos-card-shell pharos-focus-ring group flex items-center gap-3 px-4 py-3 transition-colors hover:border-frost-blue/40"
      >
        <span className="pharos-label shrink-0">API used by</span>
        <span className="flex shrink-0 -space-x-2">
          {API_PARTNERS.map((partner) => (
            // Native server markup, as in the "Seen on" strip.
            <img
              key={partner.name}
              src={partner.logoSrc}
              alt=""
              width={24}
              height={24}
              loading="lazy"
              className="h-6 w-6 rounded-full border border-background bg-background"
            />
          ))}
        </span>
        <span className="truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground">
          {formatProseList(names)}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M8 12h8m-4-4 4 4-4 4" />
        </svg>
      </Link>
    </section>
  );
}
