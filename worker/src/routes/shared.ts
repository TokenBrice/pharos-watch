import {
  getEndpointDefinitionByKey,
  type EndpointDefinition,
  type EndpointDependency,
  type EndpointKey,
} from "@shared/lib/api-endpoints";
import type { CloudflareD1StatusBindings } from "../lib/env";
import type { MintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import type { TelegramCreds } from "../lib/telegram";
import type { ChainRpcConfig } from "../lib/chain-registry";
import type { FeedbackEnv } from "../api/feedback";

/** Core context available to every route handler. */
export interface RouteContext {
  url: URL;
  db: D1Database;
  execCtx: ExecutionContext;
  request: Request;
  trustedAdmin: boolean;
}

/** Domain-specific fields for telegram webhook handlers. */
export interface TelegramRouteFields {
  telegramWebhookSecret?: string;
  telegramWebhookSecretPrevious?: string;
  telegramBotToken?: string;
  telegramCreds?: TelegramCreds | null;
}

/** Domain-specific fields for digest generation/trigger. */
export interface DigestRouteFields {
  anthropicApiKey?: string | null;
  telegramCreds?: TelegramCreds | null;
}

/** Domain-specific fields for the feedback handler. */
export interface FeedbackRouteFields {
  feedbackEnv?: FeedbackEnv;
}

/** Domain-specific fields for mint-burn / health handlers. */
export interface MintBurnRouteFields {
  alchemyApiKey?: string | null;
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig;
}

export interface ApiKeysRouteFields {
  apiKeyHashPepper?: string;
}

/** Domain-specific fields for chain RPC access. */
export interface ChainRpcRouteFields {
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export interface CloudflareD1StatusRouteFields {
  cloudflareD1StatusBindings?: CloudflareD1StatusBindings;
}

export type RouteDependency = EndpointDependency;

/** Full context built by handleHttpRequest — union of core + all domain bags. */
export type FullRouteContext = RouteContext &
  TelegramRouteFields &
  DigestRouteFields &
  FeedbackRouteFields &
  MintBurnRouteFields &
  ApiKeysRouteFields &
  ChainRpcRouteFields &
  CloudflareD1StatusRouteFields;

export type StaticRouteHandler = (context: FullRouteContext) => Promise<Response>;

export interface StaticRouteDefinition {
  endpoint: EndpointDefinition;
  handler: StaticRouteHandler;
}

export interface DynamicRouteDefinition {
  pattern: RegExp;
  dependencies?: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext, match: RegExpMatchArray) => Promise<Response>;
}

export interface RouteMatch {
  endpoint?: EndpointDefinition;
  dependencies: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext) => Promise<Response>;
}

function requireEndpoint(key: EndpointKey): EndpointDefinition {
  const endpoint = getEndpointDefinitionByKey(key);
  if (!endpoint) {
    throw new Error(`Router endpoint key "${key}" must be declared in ENDPOINT_DEFINITIONS`);
  }
  return endpoint;
}

export function defineStaticRoute(key: EndpointKey, handler: StaticRouteHandler): StaticRouteDefinition {
  return {
    endpoint: requireEndpoint(key),
    handler,
  };
}
