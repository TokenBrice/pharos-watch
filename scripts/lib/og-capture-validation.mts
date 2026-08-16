const CLOUDFLARE_CHALLENGE_TEXT: readonly string[] = ["performing security verification", "verify you are human"];

export function getOgCaptureValidationError({
  status,
  hasMainContent,
  bodyText,
}: {
  status: number;
  hasMainContent: boolean;
  bodyText: string;
}): string | null {
  const normalizedBody = bodyText.toLowerCase();

  if (CLOUDFLARE_CHALLENGE_TEXT.some((text) => normalizedBody.includes(text))) {
    return "Cloudflare security challenge rendered instead of the application";
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    return `expected a successful document response, received HTTP ${status ?? "unknown"}`;
  }
  if (!hasMainContent) {
    return 'missing required "#main-content" application shell';
  }

  return null;
}
