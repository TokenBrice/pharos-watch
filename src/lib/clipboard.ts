export type CopyTextResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "copy-failed" };

export async function copyText(text: string): Promise<CopyTextResult> {
  let attemptedModernCopy = false;

  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (typeof clipboard?.writeText === "function") {
      attemptedModernCopy = true;
      await clipboard.writeText(text);
      return { ok: true };
    }
  } catch {
    // Fall through to the legacy copy path.
  }

  if (
    typeof document === "undefined" ||
    !document.body ||
    typeof document.execCommand !== "function"
  ) {
    return { ok: false, reason: attemptedModernCopy ? "copy-failed" : "unavailable" };
  }

  let textarea: HTMLTextAreaElement | null = null;

  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    return document.execCommand("copy")
      ? { ok: true }
      : { ok: false, reason: "copy-failed" };
  } catch {
    return { ok: false, reason: "copy-failed" };
  } finally {
    if (textarea?.parentNode) textarea.parentNode.removeChild(textarea);
  }
}
