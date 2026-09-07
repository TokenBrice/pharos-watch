import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

interface MarkdownNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
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

export function requiresDocNavigation(content: string): boolean {
  const lines = content.split("\n");
  return lines.length - (lines.at(-1) === "" ? 1 : 0) >= 400 || Buffer.byteLength(content, "utf8") >= 50 * 1024;
}
