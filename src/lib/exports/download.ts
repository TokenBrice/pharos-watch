import { formatUtcDateOnly } from "@shared/lib/format";

export function formatDatedExportFilename(filename: string, extension: string): string {
  return `${filename}-${formatUtcDateOnly(new Date())}.${extension}`;
}

export function triggerUrlDownload(
  url: string,
  filename: string,
  revoke?: "sync" | "deferred",
): void {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    // a.click() requires a user-activation context; some browsers silently
    // suppress programmatic clicks; object URLs are still revoked as requested.
    a.click();
  } finally {
    if (revoke === "sync") URL.revokeObjectURL(url);
    if (revoke === "deferred") setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function triggerBlobDownload(
  blob: Blob,
  filename: string,
  revoke: "sync" | "deferred" = "deferred",
): void {
  triggerUrlDownload(URL.createObjectURL(blob), filename, revoke);
}

export function triggerFileDownload(content: BlobPart[], mime: string, filename: string): void {
  triggerBlobDownload(new Blob(content, { type: mime }), filename);
}
