import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

interface MarkdownNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
  children?: MarkdownNode[];
}

/** Use the same Markdown and heading pipeline as the public docs renderer. */
export function collectMarkdownReferences(content: string): { anchors: Set<string>; links: string[] } {
  const anchors = new Set<string>();
  const links: string[] = [];
  function visit(node: MarkdownNode): void {
    if (node.type === "element") {
      const { id, href, src } = node.properties ?? {};
      if (node.tagName && /^h[1-6]$/.test(node.tagName) && typeof id === "string") anchors.add(id);
      if (node.tagName === "a" && typeof href === "string") links.push(href);
      if (node.tagName === "img" && typeof src === "string") links.push(src);
    }
    for (const child of node.children ?? []) visit(child);
  }
  Markdown({ children: content, remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug, () => visit] });
  return { anchors, links };
}

/** Zero-based, end-exclusive source lines and UTF-16 character offsets. */
export interface MarkdownSectionRange {
  startLine: number;
  endLine: number;
  start: number;
  end: number;
}

export interface MarkdownSections {
  content: string;
  lines: string[];
  whole: MarkdownSectionRange;
  sections: ReadonlyMap<string, MarkdownSectionRange>;
}

/** Resolve source ranges using the renderer's slugs, including duplicate IDs. */
export function parseMarkdownSections(content: string): MarkdownSections {
  const lines = content.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const whole = { startLine: 0, endLine: lines.length, start: 0, end: content.length };
  const sections = new Map<string, MarkdownSectionRange>();
  const pending: Array<{ level: number; range: MarkdownSectionRange }> = [];
  function visit(node: MarkdownNode): void {
    if (node.type === "element" && node.tagName && /^h[1-6]$/.test(node.tagName)) {
      const id = node.properties?.id;
      if (typeof id === "string" && node.position) {
        const level = Number(node.tagName[1]);
        const startLine = node.position.start.line - 1;
        const start = offsets[startLine];
        while (pending.length && pending[pending.length - 1].level >= level) {
          const previous = pending.pop()!;
          previous.range.endLine = startLine;
          previous.range.end = start;
        }
        const range = { startLine, endLine: lines.length, start, end: content.length };
        sections.set(id, range);
        pending.push({ level, range });
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  Markdown({ children: content, remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug, () => visit] });
  return { content, lines, whole, sections };
}

export function resolveMarkdownSectionRange(document: MarkdownSections, anchor?: string): MarkdownSectionRange {
  if (anchor === undefined) return document.whole;
  const range = document.sections.get(anchor);
  if (!range) throw new Error(`Missing Markdown anchor: #${anchor}`);
  return range;
}

/** Union intersecting or adjacent source ranges; whole-file selection subsumes sections. */
export function mergeMarkdownSectionRanges(ranges: readonly MarkdownSectionRange[]): MarkdownSectionRange[] {
  const merged: MarkdownSectionRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function requiresDocNavigation(content: string): boolean {
  const lines = content.split("\n");
  return lines.length - (lines.at(-1) === "" ? 1 : 0) >= 400 || Buffer.byteLength(content, "utf8") >= 50 * 1024;
}
