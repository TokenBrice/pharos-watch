import Link from "next/link";

const PILL_CLASS =
  "pharos-focus-ring rounded-full border border-transparent p-1.5 hover:border-border/60 hover:bg-muted/40 hover:text-foreground";

export function TrustStrip() {
  return (
    <div
      aria-label="Trust signals"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
    >
      <Link href="/about/" className={PILL_CLASS}>
        Independent
      </Link>
      <a
        href="https://github.com/TokenBrice/pharos-watch"
        target="_blank"
        rel="noopener noreferrer"
        className={PILL_CLASS}
      >
        MIT
      </a>
      <Link href="/funding/" className={PILL_CLASS}>
        No paid placement
      </Link>
    </div>
  );
}
