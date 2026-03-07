export function splitDigestParagraphs(text: string | null | undefined): string[] {
  if (!text) return [];

  return text
    .split(/\r?\n\s*\r?\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function getDigestBodyParagraphs({
  digest,
  digestExtended,
}: {
  digest: string | null | undefined;
  digestExtended: string | null | undefined;
}): string[] {
  const extendedParagraphs = splitDigestParagraphs(digestExtended);
  if (extendedParagraphs.length > 0) return extendedParagraphs;
  return splitDigestParagraphs(digest);
}
