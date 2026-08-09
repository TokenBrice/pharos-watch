import { bytesToBase64 } from "./base64";
import { API_ORIGIN } from "./runtime-origins";

const CSP_NONCE_BYTES = 16;

export function createCspNonce(): string {
  const bytes = new Uint8Array(CSP_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

interface ContentSecurityPolicyOptions {
  telegramMiniApp?: boolean;
  nonce?: string;
}

export function isTelegramMiniAppPath(pathname: string): boolean {
  return pathname === "/pharoswatchbot/app" || pathname.startsWith("/pharoswatchbot/app/");
}

function buildScriptSrc(options: ContentSecurityPolicyOptions): string {
  // No 'unsafe-eval': the static export, GTM/GA, and telegram-web-app.js all
  // run without eval (verified against the built chunks — Mythos audit P3-58).
  const scriptSrc = [
    "'self'",
    ...(options.nonce ? [`'nonce-${options.nonce}'`] : []),
    ...(options.telegramMiniApp ? ["https://telegram.org"] : []),
    ...(!options.telegramMiniApp ? ["https://www.googletagmanager.com"] : []),
  ];
  return scriptSrc.join(" ");
}

export function buildStaticContentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): string {
  const frameAncestors = options.telegramMiniApp
    ? "frame-ancestors https://telegram.org https://*.telegram.org"
    : "frame-ancestors 'none'";
  const googleImageSources = options.telegramMiniApp
    ? ""
    : " https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://www.googletagmanager.com https://*.googletagmanager.com";
  const googleConnectSources = options.telegramMiniApp
    ? ""
    : " https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://www.googletagmanager.com https://*.googletagmanager.com";

  return [
    "default-src 'self'",
    `script-src ${buildScriptSrc(options)}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' https://coin-images.coingecko.com${googleImageSources} https://pbs.twimg.com https://abs.twimg.com data:`,
    `connect-src 'self' ${API_ORIGIN}${googleConnectSources}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestors,
  ].join("; ");
}

export function buildContentSecurityPolicy(nonce: string, options: ContentSecurityPolicyOptions = {}): string {
  return buildStaticContentSecurityPolicy({ ...options, nonce });
}

export function addNonceToInlineScripts(html: string, nonce: string): string {
  return html.replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, (_tag, attrs: string) => {
    const attrsWithoutNonce = attrs.replace(/\s+nonce=(?:"[^"]*"|'[^']*'|[^\s>]*)/i, "");
    return `<script nonce="${nonce}"${attrsWithoutNonce}>`;
  });
}
