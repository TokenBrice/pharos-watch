import Link from "next/link";

import { MEDIA_APPEARANCES } from "@/lib/media-appearances";
import { formatProseList } from "@shared/lib/format";

// A slim credibility line for the homepage tail, sized to match the status bar
// above it. Static content only — the full dated list lives on /about/#media.
export function HomeMediaStrip(): React.JSX.Element {
  const hosts = MEDIA_APPEARANCES.map((appearance) => appearance.host);

  return (
    <section aria-labelledby="home-media-strip-title" className="mt-3 sm:mt-4">
      <h2 id="home-media-strip-title" className="sr-only">
        Pharos in the media
      </h2>
      <Link
        href="/about/#media"
        prefetch={false}
        className="pharos-card-shell pharos-focus-ring group flex items-center gap-3 px-4 py-3 transition-colors hover:border-frost-blue/40"
      >
        <span className="pharos-label shrink-0">Seen on</span>
        <span className="flex shrink-0 -space-x-2">
          {MEDIA_APPEARANCES.map((appearance) => (
            // Native server markup avoids sharing Next Image's client reference
            // with the root homepage entry in descendant route manifests.
            <img
              key={appearance.href}
              src={appearance.hostLogoSrc}
              alt=""
              width={24}
              height={24}
              loading="lazy"
              className="h-6 w-6 rounded-full border border-background bg-background"
            />
          ))}
        </span>
        <span className="truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground">
          {formatProseList(hosts)}
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
