import Image from "next/image";
import { Suspense } from "react";
import { ExternalLink, BookOpen, Play } from "lucide-react";
import type { FeaturedContent } from "@shared/types";
import { PreLaunchTweetEmbed } from "@/components/pre-launch-tweet-embed";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";

function ContentTypeIcon({ type }: { type: FeaturedContent["type"] }) {
  const cls = "h-3.5 w-3.5";
  switch (type) {
    case "blog":
    case "article":
      return <BookOpen className={cls} aria-hidden="true" />;
    case "video":
      return <Play className={cls} aria-hidden="true" />;
    default:
      return <ExternalLink className={cls} aria-hidden="true" />;
  }
}

/** Extract tweet ID from an x.com or twitter.com URL. */
function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

export function FeaturedCoverage({ items }: { items: FeaturedContent[] }) {
  return (
    <section aria-labelledby="featured-coverage-title" className="space-y-3">
      <DetailSectionTitle id="featured-coverage-title">Featured coverage</DetailSectionTitle>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((item) => {
          const tweetId = item.type === "tweet" ? extractTweetId(item.url) : null;

          if (tweetId) {
            return (
              <div key={item.url} className="overflow-hidden rounded-xl [&_.react-tweet-theme]:!my-0">
                <Suspense
                  fallback={
                    <div className="flex h-40 items-center justify-center rounded-xl border border-border/60 bg-card/50 text-sm text-muted-foreground">
                      Loading tweet…
                    </div>
                  }
                >
                  <PreLaunchTweetEmbed id={tweetId} />
                </Suspense>
              </div>
            );
          }

          return (
            <a
              key={item.url}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring pharos-interactive-card group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/50"
            >
              {item.image && (
                <div className="relative aspect-[1200/630] w-full overflow-hidden bg-muted/30">
                  <Image
                    src={item.image}
                    alt={item.title}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                    unoptimized
                  />
                </div>
              )}
              <div className="flex flex-1 flex-col gap-1.5 p-4">
                <p className="text-sm font-semibold text-foreground">{item.title}</p>
                {item.description && (
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.description}</p>
                )}
                <div className="mt-auto flex items-center gap-1.5 pt-1 text-2xs text-muted-foreground/70">
                  <ContentTypeIcon type={item.type} />
                  <span>{item.source ?? item.type}</span>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
