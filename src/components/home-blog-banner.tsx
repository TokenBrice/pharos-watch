import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LATEST_BLOG_POST } from "@/data/blog";

// Days a new post stays advertised on the homepage. The check runs at build
// time (static export), so the strip self-expires on the first deploy after
// the window — no client JS, no CSP inline-script, no layout shift. Chrome
// only: sans, muted, never frost-blue; the editorial serif is blog-body only.
const FRESH_DAYS = 14;

export function HomeBlogBanner() {
  const post = LATEST_BLOG_POST;
  const publishedMs = new Date(`${post.datePublished}T00:00:00Z`).getTime();
  const ageDays = (Date.now() - publishedMs) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > FRESH_DAYS) return null;

  return (
    <aside aria-label="Latest blog post">
      <Link
        href={`/blog/${post.slug}/`}
        className="pharos-focus-ring group flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-2.5 text-sm transition-colors hover:border-border hover:bg-muted/35"
      >
        <span className="hidden shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:inline">
          From the blog
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{post.title}</span>
        <ArrowRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          strokeWidth={2}
        />
      </Link>
    </aside>
  );
}
