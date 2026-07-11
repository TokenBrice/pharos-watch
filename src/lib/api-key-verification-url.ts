const VERIFICATION_TOKEN_PREFIX = "akv_";
const VERIFICATION_TOKEN_SESSION_STORAGE_KEY = "pharos:api-key-verify-token";

function parseHashVerificationToken(hash: string): string | null {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawHash.startsWith(VERIFICATION_TOKEN_PREFIX)) return null;
  try {
    return decodeURIComponent(rawHash).trim();
  } catch {
    return null;
  }
}

function scrubHashVerificationToken(hash: string): string {
  return parseHashVerificationToken(hash) ? "" : hash;
}

function scrubQueryVerificationToken(search: string): string {
  if (!search.includes("verify=")) return search;
  const params = new URLSearchParams(search);
  if (!params.has("verify")) return search;
  params.delete("verify");
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function readVerificationTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hashToken = parseHashVerificationToken(window.location.hash);
  if (hashToken) return hashToken;
  try {
    const storedToken = window.sessionStorage?.getItem(VERIFICATION_TOKEN_SESSION_STORAGE_KEY)?.trim() ?? null;
    if (storedToken?.startsWith(VERIFICATION_TOKEN_PREFIX)) {
      window.sessionStorage.removeItem(VERIFICATION_TOKEN_SESSION_STORAGE_KEY);
      return storedToken;
    }
  } catch {
    // Storage can be disabled in privacy-restricted browsers; the hash path
    // above remains the best-effort fallback.
  }
  return null;
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

export function stripVerificationTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const nextSearch = scrubQueryVerificationToken(window.location.search);
  const nextHash = scrubHashVerificationToken(window.location.hash);
  if (nextSearch === window.location.search && nextHash === window.location.hash) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${nextSearch}${nextHash}`,
  );
}
