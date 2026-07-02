export function formatDatedExportFilename(filename: string, extension: string): string {
  return `${filename}-${new Date().toISOString().split("T")[0]}.${extension}`;
}

export function triggerFileDownload(content: BlobPart[], mime: string, filename: string): void {
  const blob = new Blob(content, { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    // a.click() requires a user-activation context; some browsers silently
    // suppress programmatic clicks, but the URL is still revoked below.
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
