import Image from "next/image";
import Link from "next/link";
import { SquareArrowRight } from "lucide-react";

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
        <span className="pharos-kicker shrink-0">Seen on</span>
        <span className="flex shrink-0 -space-x-2">
          {MEDIA_APPEARANCES.map((appearance) => (
            <Image
              key={appearance.href}
              src={appearance.hostLogoSrc}
              alt=""
              width={24}
              height={24}
              className="h-6 w-6 rounded-full border border-background bg-background"
            />
          ))}
        </span>
        <span className="truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground">
          {formatProseList(hosts)}
        </span>
        <SquareArrowRight
          aria-hidden="true"
          className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
          strokeWidth={2}
        />
      </Link>
    </section>
  );
}
