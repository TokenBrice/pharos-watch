import Link from "next/link";

const LINK_CLASS = "text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors";

export function YieldMethodologyRelatedLinks() {
  return (
    <p className="text-xs text-muted-foreground">
      See also:{" "}
      <a href="#safety-scores-methodology" className={LINK_CLASS}>Safety Scores</a>
      {" · "}
      <a href="#liquidity-methodology" className={LINK_CLASS}>Liquidity Score</a>
    </p>
  );
}

export function YieldNavTokenMechanismLinks() {
  return (
    <p className="text-xs text-muted-foreground">
      See the mechanism explainers for{" "}
      <Link href="/learn/mechanisms/tbill/" className={LINK_CLASS}>
        tokenized Treasury (T-bill) designs
      </Link>
      {" "}and{" "}
      <Link href="/learn/mechanisms/rwa-credit-fund/" className={LINK_CLASS}>
        tokenized credit funds
      </Link>
      .
    </p>
  );
}
