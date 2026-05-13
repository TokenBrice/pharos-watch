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

export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com https://static.cloudflareinsights.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://coin-images.coingecko.com https://*.google-analytics.com https://pbs.twimg.com https://abs.twimg.com data:",
    "connect-src 'self' https://api.pharos.watch https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function addNonceToInlineScripts(html: string, nonce: string): string {
  return html.replace(
    /<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)([^>]*)>/gi,
    `<script nonce="${nonce}"$1>`,
  );
}
