import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IndependentAssuranceProduct } from "@shared/lib/independent-assurance";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import { verifyIndependentAssuranceReport, type IndependentAssuranceProfile } from "../independent-assurance";
import { installAdapterNetwork, runAdapter, type AdapterHttpResponse } from "./reserve-adapter.test-support";

export const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");

export function indexFixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");
}

interface AssuranceFetchOptions {
  indexRedirect?: string;
  reportRedirect?: string;
  extraHtml?: Record<string, string | AdapterHttpResponse>;
}

export function installFetch(
  product: IndependentAssuranceProduct,
  html: string,
  options: AssuranceFetchOptions = {},
) {
  const reviewed = getIndependentAssuranceManifest(product);
  const indexResponse: string | AdapterHttpResponse = options.indexRedirect
    ? { body: html, url: options.indexRedirect }
    : html;
  const pdfBody = new TextDecoder().decode(PDF_BYTES);
  const reportResponse: AdapterHttpResponse = {
    body: pdfBody,
    headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) },
    ...(options.reportRedirect ? { url: options.reportRedirect } : {}),
  };
  return installAdapterNetwork({
    html: {
      [reviewed.officialIndexUrl]: indexResponse,
      [reviewed.reportUrl]: reportResponse,
      ...options.extraHtml,
    },
  });
}
export function verifyFixtureIndex(
  product: IndependentAssuranceProduct,
  profile: IndependentAssuranceProfile,
  fixtureName: string,
  htmlOverride?: string,
) {
  const reviewed = getIndependentAssuranceManifest(product);
  const html = htmlOverride ?? indexFixture(fixtureName);
  installFetch(product, html);
  return verifyIndependentAssuranceReport({
    manifest: reviewed,
    indexUrl: reviewed.officialIndexUrl,
    indexHost: new URL(reviewed.officialIndexUrl).hostname,
    reportHosts: [new URL(reviewed.reportUrl).hostname],
    profile,
    signal: new AbortController().signal,
  });
}


export function verifyIndex(
  adapter: LiveReserveAdapterKey,
  coinId: string,
  product: IndependentAssuranceProduct,
  html: string,
  options?: AssuranceFetchOptions,
) {
  return runAdapter(adapter, coinId, { network: installFetch(product, html, options) });
}
