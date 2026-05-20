// Liquidity — same waves glyph as the sidebar, using currentColor so the
// homepage tile can carry its product accent.

import type { JSX } from "react";
import { Waves } from "lucide-react";

export function LiquidityEmblem(): JSX.Element {
  return <Waves size={45} strokeWidth={1.75} aria-hidden="true" />;
}
