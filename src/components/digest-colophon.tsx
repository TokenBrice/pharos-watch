import Link from "next/link";
import { cn } from "@/lib/utils";

const COLOPHON_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/feed/digest.xml", label: "RSS" },
  { href: "/methodology/", label: "Methodology" },
  { href: "/privacy/", label: "Privacy" },
];

/**
 * One-line newspaper colophon that closes the digest section in place of the
 * standard site footer (suppressed across /digest by the layout). Hairline
 * top rule, mono small-caps, every segment a short label so the uppercase
 * stays readable.
 */
export function DigestColophon({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t-2 border-foreground/70 pt-4", className)}>
      <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:text-[11px]">
        <span className="font-semibold text-foreground/85">Pharos Digest</span>
        <Separator />
        <span>Watching the peg</span>
        <Separator />
        {COLOPHON_LINKS.map((link) => (
          <span key={link.href} className="inline-flex items-center gap-3">
            <Link
              href={link.href}
              className="pharos-focus-ring rounded-sm transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
            <Separator />
          </span>
        ))}
        <span>Not financial advice</span>
      </p>
    </footer>
  );
}

function Separator() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      &middot;
    </span>
  );
}
