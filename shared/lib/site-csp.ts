const CSP_NONCE_BYTES = 16;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function createCspNonce(): string {
  const bytes = new Uint8Array(CSP_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

interface ContentSecurityPolicyOptions {
  telegramMiniApp?: boolean;
}

export function isTelegramMiniAppPath(pathname: string): boolean {
  return pathname === "/pharoswatchbot/app" || pathname.startsWith("/pharoswatchbot/app/");
}

export function buildContentSecurityPolicy(nonce: string, options: ContentSecurityPolicyOptions = {}): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'unsafe-eval'",
    ...(options.telegramMiniApp ? ["https://telegram.org"] : []),
    "https://www.googletagmanager.com",
    "https://static.cloudflareinsights.com",
  ].join(" ");
  const frameAncestors = options.telegramMiniApp
    ? "frame-ancestors https://telegram.org https://*.telegram.org"
    : "frame-ancestors 'none'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://coin-images.coingecko.com https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://pbs.twimg.com https://abs.twimg.com data:",
    "connect-src 'self' https://api.pharos.watch https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://www.googletagmanager.com https://*.googletagmanager.com",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestors,
  ].join("; ");
}

export function addNonceToInlineScripts(html: string, nonce: string): string {
  return html.replace(
    /<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)([^>]*)>/gi,
    `<script nonce="${nonce}"$1>`,
  );
}
