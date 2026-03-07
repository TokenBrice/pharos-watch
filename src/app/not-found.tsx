import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center gap-6 text-center">
      <Image src="/pharos-icon.png" alt="Pharos" width={120} height={120} className="opacity-20" />
      <div className="space-y-2">
        <h1 className="text-6xl font-bold font-mono tracking-tight">404</h1>
        <p className="text-muted-foreground font-mono">Trail gone cold.</p>
      </div>
      <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
        The page you asked for is missing, moved, or no longer tracked. Use one of the recovery paths below to get back
        into the dashboard.
      </p>
      <div className="grid w-full gap-3 sm:grid-cols-2">
        <Link
          href="/"
          className="pharos-focus-ring rounded-2xl border border-border/60 bg-card/70 px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Dashboard
        </Link>
        <Link
          href="/stablecoins/usd/"
          className="pharos-focus-ring rounded-2xl border border-border/60 bg-card/70 px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Browse Stablecoins
        </Link>
        <Link
          href="/digest/"
          className="pharos-focus-ring rounded-2xl border border-border/60 bg-card/70 px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Daily Digest
        </Link>
        <Link
          href="/compare/"
          className="pharos-focus-ring rounded-2xl border border-border/60 bg-card/70 px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Compare Tools
        </Link>
      </div>
    </div>
  );
}
