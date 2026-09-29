/**
 * Scrubs legacy `?verify=` tokens from inbound URLs before analytics reads
 * `window.location.search`, so verification credentials never reach page-view
 * payloads. Hash-token consumption lives with the Worker-issued links only.
 */
function scrubQueryVerificationToken(search: string): string {
  if (!search.includes("verify=")) return search;
  const params = new URLSearchParams(search);
  if (!params.has("verify")) return search;
  params.delete("verify");
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function stripQueryVerificationTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const nextSearch = scrubQueryVerificationToken(window.location.search);
  if (nextSearch === window.location.search) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${nextSearch}${window.location.hash}`,
  );
}
