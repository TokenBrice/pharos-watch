import fs from "node:fs/promises";
import path from "node:path";
import { cache } from "react";

export interface MarkdownParagraphBlock {
  type: "paragraph";
  text: string;
}

export interface MarkdownListBlock {
  type: "list";
  ordered: boolean;
  items: string[];
}

export interface MarkdownTableBlock {
  type: "table";
  headers: string[];
  rows: string[][];
}

export interface MarkdownCodeBlock {
  type: "code";
  language: string;
  code: string;
}

export interface MarkdownRuleBlock {
  type: "rule";
}

export type MarkdownBlock =
  | MarkdownParagraphBlock
  | MarkdownListBlock
  | MarkdownTableBlock
  | MarkdownCodeBlock
  | MarkdownRuleBlock;

export interface ApiReferenceSection {
  id: string;
  title: string;
  blocks: MarkdownBlock[];
  subsections: Array<{
    id: string;
    title: string;
    method: "GET" | "POST" | null;
    blocks: MarkdownBlock[];
  }>;
}

export interface ApiReferenceDocument {
  introBlocks: MarkdownBlock[];
  sections: ApiReferenceSection[];
}

const API_REFERENCE_PATH = path.join(process.cwd(), "docs/api-reference.md");

function slugifyHeading(value: string) {
  return value
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function isTableSeparatorLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const cells = splitPlainTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
}

function isHeadingLine(line: string) {
  return line.startsWith("# ");
}

function isSectionLine(line: string) {
  return line.startsWith("## ");
}

function isSubsectionLine(line: string) {
  return line.startsWith("### ");
}

function splitTableRow(line: string) {
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
  }

  cells.push(current.trim());
  return cells;
}

function splitPlainTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isUnorderedListLine(line: string) {
  return /^\s*-\s+/.test(line);
}

function isOrderedListLine(line: string) {
  return /^\s*\d+\.\s+/.test(line);
}

function isCodeFence(line: string) {
  return line.trim().startsWith("```");
}

function isRuleLine(line: string) {
  return line.trim() === "---";
}

function parseList(lines: string[], startIndex: number, ordered: boolean) {
  const items: string[] = [];
  let index = startIndex;
  let current = "";

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) break;
    if (isSectionLine(line) || isSubsectionLine(line) || isHeadingLine(line) || isRuleLine(line) || isCodeFence(line)) break;
    if (trimmed.startsWith("|") && isTableSeparatorLine(lines[index + 1] ?? "")) break;

    const matcher = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*-\s+(.*)$/;
    const match = trimmed.match(matcher);
    if (match) {
      if (current.length > 0) {
        items.push(current.trim());
      }
      current = match[1] ?? "";
      index += 1;
      continue;
    }

    if (current.length === 0) break;
    current = `${current} ${trimmed}`.trim();
    index += 1;
  }

  if (current.length > 0) {
    items.push(current.trim());
  }

  return {
    block: {
      type: "list",
      ordered,
      items,
    } as MarkdownListBlock,
    nextIndex: index,
  };
}

function parseCodeBlock(lines: string[], startIndex: number) {
  const opening = lines[startIndex]?.trim() ?? "";
  const language = opening.slice(3).trim();
  const codeLines: string[] = [];
  let index = startIndex + 1;

  while (index < lines.length && !isCodeFence(lines[index] ?? "")) {
    codeLines.push(lines[index] ?? "");
    index += 1;
  }

  return {
    block: {
      type: "code",
      language,
      code: codeLines.join("\n").trimEnd(),
    } as MarkdownCodeBlock,
    nextIndex: Math.min(index + 1, lines.length),
  };
}

function parseTable(lines: string[], startIndex: number) {
  const headers = splitTableRow(lines[startIndex] ?? "");
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
    rows.push(splitTableRow(lines[index] ?? ""));
    index += 1;
  }

  return {
    block: {
      type: "table",
      headers,
      rows,
    } as MarkdownTableBlock,
    nextIndex: index,
  };
}

function parseParagraph(lines: string[], startIndex: number) {
  const paragraphLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) break;
    if (isSectionLine(line) || isSubsectionLine(line) || isHeadingLine(line) || isRuleLine(line) || isCodeFence(line)) break;
    if (isUnorderedListLine(line) || isOrderedListLine(line)) break;
    if (trimmed.startsWith("|") && isTableSeparatorLine(lines[index + 1] ?? "")) break;

    paragraphLines.push(trimmed);
    index += 1;
  }

  return {
    block: {
      type: "paragraph",
      text: paragraphLines.join(" ").trim(),
    } as MarkdownParagraphBlock,
    nextIndex: index,
  };
}

function parseBlocks(lines: string[]) {
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (isRuleLine(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (isCodeFence(line)) {
      const parsed = parseCodeBlock(lines, index);
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }

    if (trimmed.startsWith("|") && isTableSeparatorLine(lines[index + 1] ?? "")) {
      const parsed = parseTable(lines, index);
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }

    if (isUnorderedListLine(line)) {
      const parsed = parseList(lines, index, false);
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }

    if (isOrderedListLine(line)) {
      const parsed = parseList(lines, index, true);
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }

    const parsed = parseParagraph(lines, index);
    blocks.push(parsed.block);
    index = parsed.nextIndex;
  }

  return blocks;
}

function parseApiReferenceDocument(markdown: string): ApiReferenceDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const introLines: string[] = [];
  const sections: ApiReferenceSection[] = [];
  let currentSection: ApiReferenceSection | null = null;
  let currentSubsection: ApiReferenceSection["subsections"][number] | null = null;
  let lineBuffer: string[] = [];

  function flushBuffer() {
    if (lineBuffer.length === 0) return;

    const blocks = parseBlocks(lineBuffer);
    if (currentSubsection) {
      currentSubsection.blocks.push(...blocks);
    } else if (currentSection) {
      currentSection.blocks.push(...blocks);
    } else {
      introLines.push(...lineBuffer);
    }
    lineBuffer = [];
  }

  for (const line of lines) {
    if (isHeadingLine(line)) {
      flushBuffer();
      continue;
    }

    if (isSectionLine(line)) {
      flushBuffer();
      currentSubsection = null;
      currentSection = {
        id: slugifyHeading(line.slice(3).trim()),
        title: line.slice(3).trim(),
        blocks: [],
        subsections: [],
      };
      sections.push(currentSection);
      continue;
    }

    if (isSubsectionLine(line)) {
      flushBuffer();
      if (!currentSection) continue;
      const rawTitle = line.slice(4).trim();
      const methodMatch = rawTitle.replace(/`/g, "").match(/^(GET|POST)\s+/);
      currentSubsection = {
        id: slugifyHeading(rawTitle),
        title: rawTitle,
        method: methodMatch ? (methodMatch[1] as "GET" | "POST") : null,
        blocks: [],
      };
      currentSection.subsections.push(currentSubsection);
      continue;
    }

    lineBuffer.push(line);
  }

  flushBuffer();

  return {
    introBlocks: parseBlocks(introLines),
    sections,
  };
}

export const loadApiReferenceDocument = cache(async (): Promise<ApiReferenceDocument> => {
  const markdown = await fs.readFile(API_REFERENCE_PATH, "utf8");
  return parseApiReferenceDocument(markdown);
});
