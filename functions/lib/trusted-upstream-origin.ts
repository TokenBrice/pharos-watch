export function resolveTrustedHttpsOrigin(
  configuredValue: string | null | undefined,
  allowedOrigins: readonly string[],
): string | null {
  const trimmed = configuredValue?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
      || (url.pathname !== "" && url.pathname !== "/")
      || url.search !== ""
      || url.hash !== ""
    ) {
      return null;
    }

    return allowedOrigins.includes(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}
