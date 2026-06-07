import type { ReactNode } from "react";
import { Term } from "@/components/term";
import { parseTermMarkup } from "@/lib/term-markup";

interface TermTextProps {
  text: string;
}

function renderTermMarkup(text: string): ReactNode[] {
  return parseTermMarkup(text).map((segment, index) => {
    if (segment.type === "term") {
      return (
        <Term key={`term-${index}`} slug={segment.slug}>
          {segment.label}
        </Term>
      );
    }

    return segment.text;
  });
}

export function TermText({ text }: TermTextProps) {
  return <>{renderTermMarkup(text)}</>;
}
