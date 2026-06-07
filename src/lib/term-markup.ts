export type TermMarkupSegment =
  | { type: "text"; text: string }
  | { type: "term"; slug: string; label: string };

const TERM_MARKUP_PATTERN = /\{\{term:([a-z][a-z0-9-]*)\}\}([\s\S]*?)\{\{\/term\}\}/g;

export function parseTermMarkup(text: string): TermMarkupSegment[] {
  const segments: TermMarkupSegment[] = [];
  const regex = new RegExp(TERM_MARKUP_PATTERN);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }

    const [, slug, label] = match;
    segments.push({ type: "term", slug, label });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }

  return segments;
}

export function stripTermMarkup(text: string): string {
  return parseTermMarkup(text)
    .map((segment) => (segment.type === "term" ? segment.label : segment.text))
    .join("");
}
