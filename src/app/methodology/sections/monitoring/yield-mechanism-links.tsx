import Link from "next/link";
import { METHODOLOGY_LINK_CLASS } from "../../methodology-shared";

export function YieldMethodologyRelatedLinks() {
  return (
    <p className="text-xs text-muted-foreground">
      See also:{" "}
      <a href="#safety-scores-methodology" className={METHODOLOGY_LINK_CLASS}>Safety Scores</a>
      {" · "}
      <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>Liquidity Score</a>
    </p>
  );
}

export function YieldNavTokenMechanismLinks() {
  return (
    <p className="text-xs text-muted-foreground">
      See the mechanism explainers for{" "}
      <Link href="/learn/mechanisms/tbill/" className={METHODOLOGY_LINK_CLASS}>
        tokenized Treasury (T-bill) designs
      </Link>
      {" "}and{" "}
      <Link href="/learn/mechanisms/rwa-credit-fund/" className={METHODOLOGY_LINK_CLASS}>
        tokenized credit funds
      </Link>
      .
    </p>
  );
}
