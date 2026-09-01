import { basename, extname } from "node:path";
import ts from "typescript";

import type {
  EditorialExtractorOptions,
  EditorialSurfaceEntry,
  EditorialSurfaceOwnership,
} from "./editorial-surface-registry";

export type EditorialExtractorKind = "json-fields" | "structured-data" | "markdown-body";
export type EditorialUnitOwnership = "pharos" | "quoted" | "user";

export interface ExtractedEditorialUnit {
  readonly record: string;
  readonly field: string;
  readonly text: string;
  /** UTF-16 offset in the source file. `text` keeps source length when masked. */
  readonly sourceOffset: number;
  readonly ownership: EditorialUnitOwnership;
  readonly exemptions?: readonly string[];
}

export interface EditorialExtractionInput {
  readonly path: string;
  readonly source: string;
  readonly ownership: EditorialSurfaceOwnership;
  readonly options?: EditorialExtractorOptions;
}


interface JsonStringNode {
  readonly value: string;
  readonly offset: number;
  readonly path: readonly string[];
  readonly root: unknown;
}

const NON_PROSE_FIELDS = new Set([
  "id",
  "coinId",
  "slug",
  "symbol",
  "term",
  "type",
  "kind",
  "status",
  "severity",
  "level",
  "confidence",
  "quality",
  "applicability",
  "category",
  "chain",
  "address",
  "url",
  "href",
  "sourceUrl",
  "sourceKey",
  "image",
  "imageSrc",
  "geckoId",
  "llamaId",
  "date",
  "dateISO",
  "deathDate",
  "frozenAt",
  "updatedAt",
  "generatedAt",
  "publishedAt",
  "effectiveAt",
  "launchDate",
  "expectedLaunchDate",
  "version",
  "owner",
  "source",
  "sourceKind",
  "sourceDate",
  "reviewBy",
  "changedAt",
  "reviewedAt",
  "reviewer",
  "controlRef",
]);
const USER_CONTENT_FIELD_RE = /(?:user|donor|submitted|issuerProvided|issuerText|feedback)/i;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>{}\[\]"']+/gi;
const CODE_SPAN_RE = /`[^`\n]*`/g;
const NUMBER_RE = /(?<![A-Za-z])[-+]?\d[\d.,]*(?:\s*[%a-zA-Z]+)?(?:\s*[\u2012-\u2015\u2212-]\s*[-+]?\d[\d.,]*(?:\s*[%a-zA-Z]+)?)?/g;

function blankRange(text: string, start: number, end: number): string {
  let result = "";
  for (let index = start; index < end; index += 1) result += text[index] === "\n" ? "\n" : " ";
  return result;
}

function maskMatches(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => blankRange(match, 0, match.length));
}

/** Masks syntax that is not Pharos prose while preserving source offsets. */
export function maskEditorialSourceText(text: string): string {
  return maskMatches(maskMatches(maskMatches(text, CODE_SPAN_RE), URL_RE), NUMBER_RE);
}

function normalizedFileRecord(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(0, normalized.length - extname(normalized).length);
}

function fieldName(path: readonly string[]): string {
  return path.map((segment) => (/^\d+$/.test(segment) ? "*" : segment)).join(".");
}

function pathPatternMatches(pattern: string, path: readonly string[]): boolean {
  const patternParts = pattern.split(".").filter(Boolean);
  const matches = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === patternParts.length) return pathIndex === path.length;
    const patternPart = patternParts[patternIndex]!;
    if (patternPart === "**") {
      if (matches(patternIndex + 1, pathIndex)) return true;
      return pathIndex < path.length && matches(patternIndex, pathIndex + 1);
    }
    if (pathIndex >= path.length) return false;
    if (patternPart !== "*" && patternPart !== path[pathIndex]) return false;
    return matches(patternIndex + 1, pathIndex + 1);
  };
  return matches(0, 0);
}

function selectedJsonPath(path: readonly string[], fields: readonly string[]): boolean {
  return fields.some((pattern) => pathPatternMatches(pattern, path));
}

function lastPathPart(path: readonly string[]): string {
  return path[path.length - 1] ?? "";
}


function isSkippedJsonPath(path: readonly string[], value: string, options: EditorialExtractorOptions): boolean {
  const last = lastPathPart(path);
  if (NON_PROSE_FIELDS.has(last) || USER_CONTENT_FIELD_RE.test(last)) return true;
  if (Object.keys(options.excludedFields ?? {}).some((pattern) => pathPatternMatches(pattern, path))) return true;
  if (value.trim().length === 0) return true;
  return false;
}

function ownershipForPath(
  ownership: EditorialSurfaceOwnership,
  path: readonly string[],
  root?: unknown,
): EditorialUnitOwnership {
  if (ownership === "quoted" || (root !== undefined && quotedJsonNode(root, path))) return "quoted";
  if (ownership === "pharos") return "pharos";
  if (path.some((part) => USER_CONTENT_FIELD_RE.test(part))) return "user";
  return "pharos";
}

function consumeJsonString(source: string, start: number): { value: string; offset: number; next: number } {
  const offset = start;
  let index = start + 1;
  let escaped = false;
  for (; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      const raw = source.slice(start, index + 1);
      return { value: JSON.parse(raw) as string, offset, next: index + 1 };
    }
  }
  throw new Error(`[editorial-style] Unterminated JSON string at offset ${start}.`);
}

function skipJsonWhitespace(source: string, index: number): number {
  while (index < source.length && /\s/u.test(source[index]!)) index += 1;
  return index;
}

/**
 * Walk the source JSON lexically rather than walking JSON.parse's object graph.
 * Duplicate object keys are legal input to JSON.parse but retain the first key's
 * insertion position, which makes object-graph traversal unable to recover
 * source offsets. A lexical walk preserves every path and token in source order.
 */
function collectJsonStringNodes(source: string, root: unknown): JsonStringNode[] {
  const nodes: JsonStringNode[] = [];
  let index = 0;

  const parseValue = (path: readonly string[]): void => {
    index = skipJsonWhitespace(source, index);
    const char = source[index];
    if (char === '"') {
      const token = consumeJsonString(source, index);
      index = token.next;
      nodes.push({ value: token.value, offset: token.offset, path, root });
      return;
    }
    if (char === "{") {
      index += 1;
      index = skipJsonWhitespace(source, index);
      while (index < source.length && source[index] !== "}") {
        const key = consumeJsonString(source, index);
        index = skipJsonWhitespace(source, key.next);
        if (source[index] !== ":") {
          throw new Error(`[editorial-style] Invalid JSON object near offset ${index}.`);
        }
        index += 1;
        parseValue([...path, key.value]);
        index = skipJsonWhitespace(source, index);
        if (source[index] === ",") {
          index += 1;
          index = skipJsonWhitespace(source, index);
        }
      }
      if (source[index] !== "}") throw new Error(`[editorial-style] Invalid JSON object near offset ${index}.`);
      index += 1;
      return;
    }
    if (char === "[") {
      index += 1;
      index = skipJsonWhitespace(source, index);
      let itemIndex = 0;
      while (index < source.length && source[index] !== "]") {
        parseValue([...path, String(itemIndex)]);
        itemIndex += 1;
        index = skipJsonWhitespace(source, index);
        if (source[index] === ",") {
          index += 1;
          index = skipJsonWhitespace(source, index);
        }
      }
      if (source[index] !== "]") throw new Error(`[editorial-style] Invalid JSON array near offset ${index}.`);
      index += 1;
      return;
    }
    // Numbers, booleans and null cannot contain editorial text. Advance to the
    // next structural delimiter; nested values are handled by object/array arms.
    while (index < source.length && !",]}".includes(source[index]!)) index += 1;
  };

  parseValue([]);
  return nodes;
}

function primitiveIdentity(value: unknown, fields: readonly string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const explicit = fields
    .map((field) => [field, object[field]] as const)
    .filter(([, candidate]) => typeof candidate === "string" && candidate.length > 0);
  if (explicit.length > 0) return explicit.map(([field, candidate]) => `${field}=${candidate}`).join("|");
  const fallbackFields = ["id", "slug", "key", "name", "label", "date", "dateISO", "type", "kind", "chain", "component", "branch"];
  const fallback = fallbackFields
    .map((field) => [field, object[field]] as const)
    .find(([, candidate]) => typeof candidate === "string" && candidate.length > 0);
  return fallback ? `${fallback[0]}=${fallback[1]}` : null;
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[Number(segment)] : (current as Record<string, unknown>)[segment];
  }
  return current;
}
function quotedJsonNode(root: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return false;
  const parent = valueAtPath(root, path.slice(0, -1));
  return Boolean(parent && typeof parent === "object" && !Array.isArray(parent) && (parent as Record<string, unknown>).quoted === true);
}

function jsonRootRecord(
  root: unknown,
  path: readonly string[],
  filePath: string,
  strategy: EditorialExtractorOptions["rootRecord"],
): string {
  const object = root && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>) : null;
  if (strategy === "key" && path.length > 0) return path[0]!;
  if (strategy !== "file" && typeof object?.id === "string" && object.id.length > 0) return object.id;
  if (strategy !== "file" && !Array.isArray(root) && path.length > 0 && typeof path[0] === "string" && path[0]!.length > 0) {
    return path[0]!;
  }
  return normalizedFileRecord(filePath);
}

function jsonRecordForPath(
  root: unknown,
  path: readonly string[],
  filePath: string,
  options: EditorialExtractorOptions,
): string {
  const rootRecord = jsonRootRecord(root, path, filePath, options.rootRecord);
  const identities: string[] = [];
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const item = current[Number(segment)];
      const identity = primitiveIdentity(item, options.identityFields ?? []);
      if (identity) identities.push(identity);
      current = item;
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      break;
    }
  }
  return identities.length > 0 ? `${rootRecord}/${identities.join("/")}` : rootRecord;
}

export function extractJsonEditorialUnits(input: EditorialExtractionInput): readonly ExtractedEditorialUnit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.source) as unknown;
  } catch (error) {
    throw new Error(`[editorial-style] ${input.path} is not valid JSON: ${(error as Error).message}`);
  }
  const options = input.options ?? {};
  const fields = options.fields ?? ["**"];
  const nodes = collectJsonStringNodes(input.source, parsed);
  return nodes
    .filter((node) => selectedJsonPath(node.path, fields))
    .filter((node) => !isSkippedJsonPath(node.path, node.value, options))
    .map((node) => ({
      record: jsonRecordForPath(node.root, node.path, input.path, options),
      field: fieldName(node.path),
      text: maskEditorialSourceText(node.value),
      sourceOffset: node.offset,
      ownership: ownershipForPath(input.ownership, node.path, node.root),
      exemptions: options.exemptions,
    }))
    .filter((unit) => unit.text.trim().length > 0);
}

function propertyName(property: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!property) return null;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) return property.text;
  return null;
}

function unwrapTsExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function staticTsProperty(object: ts.ObjectLiteralExpression, name: string): string | null {
  const property = object.properties.find((candidate) => {
    return ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name;
  });
  if (!property || !ts.isPropertyAssignment(property)) return null;
  const value = unwrapTsExpression(property.initializer);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  return null;
}

function structuredRecord(
  object: ts.ObjectLiteralExpression,
  inherited: string,
  options: EditorialExtractorOptions,
  filePath: string,
): string {
  const fields = options.identityFields ?? [];
  const values = fields
    .map((field) => [field, staticTsProperty(object, field)] as const)
    .filter(([, value]) => value !== null && value.length > 0);
  if (values.length > 0) return `${inherited}/${values.map(([field, value]) => `${field}=${value}`).join("|")}`;
  const fallbackFields = ["id", "slug", "version", "archetype", "dateISO", "heading", "title", "name", "coinId"];
  const fallback = fallbackFields
    .map((field) => [field, staticTsProperty(object, field)] as const)
    .find(([, value]) => value !== null && value.length > 0);
  return fallback ? `${inherited}/${fallback[0]}=${fallback[1]}` : inherited || normalizedFileRecord(filePath);
}

function selectedStructuredField(key: string, fields: readonly string[]): boolean {
  return fields.some((pattern) => pattern === key || pattern === `**.${key}` || pattern === "**");
}

function tsTextNode(node: ts.Expression): { text: string; offset: number } | null {
  const unwrapped = unwrapTsExpression(node);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return { text: unwrapped.text, offset: unwrapped.getStart() };
  }
  return null;
}

function shouldSkipStructuredField(path: readonly string[], text: string): boolean {
  const last = lastPathPart(path);
  if (NON_PROSE_FIELDS.has(last) || USER_CONTENT_FIELD_RE.test(last)) return true;
  if (path.some((part) => part === "sources" || part === "source") && last !== "description") return true;
  if (last === "className" || last === "style" || last === "children") return true;
  return text.trim().length === 0;
}

function collectStructuredValue(
  node: ts.Expression,
  record: string,
  field: string,
  path: readonly string[],
  input: EditorialExtractionInput,
  options: EditorialExtractorOptions,
  units: ExtractedEditorialUnit[],
): void {
  const unwrapped = unwrapTsExpression(node);
  const literal = tsTextNode(unwrapped);
  if (literal) {
    if (!shouldSkipStructuredField(path, literal.text)) {
      units.push({
        record,
        field,
        text: maskEditorialSourceText(literal.text),
        sourceOffset: literal.offset,
        ownership: ownershipForPath(input.ownership, path),
        exemptions: options.exemptions,
      });
    }
    return;
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (ts.isSpreadElement(element)) continue;
      collectStructuredValue(element, record, field, path, input, options, units);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const nestedRecord = structuredRecord(unwrapped, record, options, input.path);
    collectStructuredObject(unwrapped, nestedRecord, path, input, options, units);
  }
}

function collectStructuredObject(
  object: ts.ObjectLiteralExpression,
  record: string,
  parentPath: readonly string[],
  input: EditorialExtractionInput,
  options: EditorialExtractorOptions,
  units: ExtractedEditorialUnit[],
): void {
  const fields = options.fields ?? [];
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    if (!key) continue;
    const path = [...parentPath, key];
    if (selectedStructuredField(key, fields)) {
      collectStructuredValue(property.initializer, record, key, path, input, options, units);
      continue;
    }
    const initializer = unwrapTsExpression(property.initializer);
    if (ts.isObjectLiteralExpression(initializer)) {
      collectStructuredObject(initializer, structuredRecord(initializer, record, options, input.path), path, input, options, units);
    } else if (ts.isArrayLiteralExpression(initializer)) {
      for (const element of initializer.elements) {
        if (ts.isObjectLiteralExpression(element)) {
          collectStructuredObject(
            element,
            structuredRecord(element, record, options, input.path),
            path,
            input,
            options,
            units,
          );
        }
      }
    }
  }
}

function metadataObjectLiterals(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const roots: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && propertyName(node.name) === "metadata") {
      const initializer = node.initializer && unwrapTsExpression(node.initializer);
      if (initializer && ts.isObjectLiteralExpression(initializer)) roots.push(initializer);
      if (initializer && ts.isCallExpression(initializer)) {
        const argument = initializer.arguments.find(ts.isObjectLiteralExpression);
        if (argument) roots.push(argument);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "buildPageMetadata") {
      const argument = node.arguments.find(ts.isObjectLiteralExpression);
      if (argument) roots.push(argument);
    }
    ts.forEachChild(node, visit);
  };
  return [...new Set(roots)];
}

function topLevelNamedInitializers(sourceFile: ts.SourceFile, names: readonly string[]): Array<[string, ts.Expression]> {
  const result: Array<[string, ts.Expression]> = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = propertyName(declaration.name);
      if (name && names.includes(name) && declaration.initializer) result.push([name, declaration.initializer]);
    }
  }
  return result;
}

export function extractStructuredEditorialUnits(input: EditorialExtractionInput): readonly ExtractedEditorialUnit[] {
  const sourceFile = ts.createSourceFile(
    input.path,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx?$/.test(input.path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const options = input.options ?? {};
  const units: ExtractedEditorialUnit[] = [];
  const fallbackRecord = normalizedFileRecord(input.path);
  const roots: ts.Expression[] = options.metadataOnly
    ? metadataObjectLiterals(sourceFile)
    : sourceFile.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => statement.declarationList.declarations)
        .map((declaration) => declaration.initializer)
        .filter((initializer): initializer is ts.Expression => initializer !== undefined);
  for (const root of roots) {
    const unwrapped = unwrapTsExpression(root);
    const record = ts.isObjectLiteralExpression(unwrapped)
      ? structuredRecord(unwrapped, fallbackRecord, options, input.path)
      : fallbackRecord;
    collectStructuredValue(root, record, "", [], input, options, units);
  }
  for (const [name, initializer] of topLevelNamedInitializers(sourceFile, options.topLevelNames ?? [])) {
    collectStructuredValue(initializer, fallbackRecord, name, [name], input, options, units);
  }
  return units.filter((unit) => unit.text.trim().length > 0);
}

function maskMarkdownLine(line: string): string {
  return blankRange(line, 0, line.length);
}

function cleanMarkdownLine(line: string): string {
  let cleaned = line;
  cleaned = cleaned.replace(/`[^`\n]*`/g, (match) => blankRange(match, 0, match.length));
  cleaned = cleaned.replace(/!?(\[[^\]]*\])\((https?:\/\/[^)]+)\)/gi, (match, label: string, url: string) => {
    if (/^https?:\/\//i.test(url)) return blankRange(match, 0, match.length);
    return `${blankRange(label, 0, label.length)}${blankRange(url, 0, url.length)}`;
  });
  cleaned = cleaned.replace(/<https?:\/\/[^>]+>/gi, (match) => blankRange(match, 0, match.length));
  cleaned = cleaned.replace(URL_RE, (match) => blankRange(match, 0, match.length));
  cleaned = cleaned.replace(/<[^>]+>/g, (match) => blankRange(match, 0, match.length));
  return maskEditorialSourceText(cleaned);
}

export function extractMarkdownEditorialUnits(input: EditorialExtractionInput): readonly ExtractedEditorialUnit[] {
  const lines = input.source.split("\n");
  const output: string[] = [];
  let offset = 0;
  let inFrontmatter = lines[0]?.trim() === "---";
  let inFence = false;
  let fenceMarker = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (inFrontmatter) {
      output.push(maskMarkdownLine(line));
      if (trimmed === "---" && offset > 0) inFrontmatter = false;
    } else if (/^(?:```|~~~)/.test(trimmed)) {
      if (!inFence) {
        inFence = true;
        fenceMarker = trimmed.slice(0, 3);
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      output.push(maskMarkdownLine(line));
    } else if (inFence || /^\s*>/.test(line)) {
      output.push(maskMarkdownLine(line));
    } else {
      output.push(cleanMarkdownLine(line));
    }
    offset += line.length + 1;
  }
  const text = output.join("\n");
  if (text.trim().length === 0) return [];
  return [
    {
      record: normalizedFileRecord(input.path),
      field: "body",
      text,
      sourceOffset: 0,
      ownership: input.ownership === "quoted" ? "quoted" : input.ownership === "mixed" ? "pharos" : input.ownership,
      exemptions: input.options?.exemptions,
    },
  ];
}

export function extractEditorialUnits(
  kind: EditorialExtractorKind,
  input: EditorialExtractionInput,
): readonly ExtractedEditorialUnit[] {
  if (kind === "json-fields") return extractJsonEditorialUnits(input);
  if (kind === "structured-data") return extractStructuredEditorialUnits(input);
  return extractMarkdownEditorialUnits(input);
}

export function extractUnitsForSurface(
  surface: EditorialSurfaceEntry,
  path: string,
  source: string,
): readonly ExtractedEditorialUnit[] {
  return extractEditorialUnits(surface.extractor, {
    path,
    source,
    ownership: surface.ownership,
    options: surface.options,
  });
}

export function extractorFamily(kind: EditorialExtractorKind): "json" | "structured" | "markdown" {
  if (kind === "json-fields") return "json";
  if (kind === "structured-data") return "structured";
  return "markdown";
}

export function displayRecordForPath(path: string): string {
  return basename(normalizedFileRecord(path));
}
