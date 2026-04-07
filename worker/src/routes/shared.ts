import {
  getEndpointDefinitionByKey,
  type EndpointDefinitionByKey,
  type EndpointDependenciesForKey,
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

export type RouteDependency = EndpointDependency;

export interface TelegramRouteFields {
  telegramWebhookSecret: string | undefined;
  telegramWebhookSecretPrevious: string | undefined;
  telegramBotToken: string | undefined;
  telegramCreds: TelegramCreds | null;
}

export interface DigestRouteFields {
  anthropicApiKey: string | null;
  telegramCreds: TelegramCreds | null;
}

export interface FeedbackRouteFields {
  feedbackEnv: FeedbackEnv;
}

export interface MintBurnFreshnessRouteFields {
  mintBurnFreshnessConfig: MintBurnFreshnessConfig;
}

export interface AlchemyRouteFields {
  alchemyApiKey: string | null;
}

export interface ApiKeysRouteFields {
  apiKeyHashPepper: string | undefined;
}

export interface CoingeckoRouteFields {
  coingeckoApiKey: string | null;
}

export interface ChainRpcRouteFields {
  chainRpcs: Map<string, ChainRpcConfig>;
}

export interface CloudflareD1StatusRouteFields {
  cloudflareD1StatusBindings: CloudflareD1StatusBindings;
}

export interface RouteDependencyFieldMap {
  apiKeyHashPepper: ApiKeysRouteFields;
  alchemyApiKey: AlchemyRouteFields;
  anthropicApiKey: Pick<DigestRouteFields, "anthropicApiKey">;
  cloudflareD1StatusConfig: CloudflareD1StatusRouteFields;
  chainRpcs: ChainRpcRouteFields;
  coingeckoApiKey: CoingeckoRouteFields;
  feedbackEnv: FeedbackRouteFields;
  mintBurnFreshnessConfig: MintBurnFreshnessRouteFields;
  telegram: TelegramRouteFields;
}

type Optionalize<T> = {
  [K in keyof T]?: T[K];
};

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends ((value: infer I) => void)
  ? I
  : never;

type AllRouteDependencyFields = UnionToIntersection<RouteDependencyFieldMap[RouteDependency]>;

type RequiredRouteDependencyFields<Deps extends readonly RouteDependency[]> =
  [Deps[number]] extends [never]
    ? Record<never, never>
    : UnionToIntersection<RouteDependencyFieldMap[Deps[number]]>;

/** Full context shape used by generic routing internals before a route narrows its dependencies. */
export type FullRouteContext = RouteContext & Optionalize<AllRouteDependencyFields>;

/** Context seen by a route once its declared dependencies have been hydrated. */
export type RouteContextFor<Deps extends readonly RouteDependency[]> =
  RouteContext &
  Omit<Optionalize<AllRouteDependencyFields>, keyof RequiredRouteDependencyFields<Deps>> &
  RequiredRouteDependencyFields<Deps>;

export type StaticRouteHandler<K extends EndpointKey> = (context: RouteContextFor<EndpointDependenciesForKey<K>>) => Promise<Response>;

export interface StaticRouteDefinition {
  endpoint: EndpointDefinition;
  handler: (context: FullRouteContext) => Promise<Response>;
}

export interface DynamicRouteDefinition {
  pattern: RegExp;
  dependencies: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext, match: RegExpMatchArray) => Promise<Response>;
}

export interface RouteMatch {
  endpoint?: EndpointDefinition;
  dependencies: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext) => Promise<Response>;
}

export type DynamicRouteHandler<Deps extends readonly RouteDependency[]> = (
  routeCtx: RouteContextFor<Deps>,
  match: RegExpMatchArray,
) => Promise<Response>;

function requireEndpoint<K extends EndpointKey>(key: K): EndpointDefinitionByKey<K> {
  const endpoint = getEndpointDefinitionByKey(key);
  if (!endpoint) {
    throw new Error(`Router endpoint key "${key}" must be declared in ENDPOINT_DEFINITIONS`);
  }
  return endpoint as EndpointDefinitionByKey<K>;
}

export function defineStaticRoute<K extends EndpointKey>(key: K, handler: StaticRouteHandler<K>): StaticRouteDefinition {
  return {
    endpoint: requireEndpoint(key),
    handler: handler as StaticRouteDefinition["handler"],
  };
}

export function defineDynamicRoute<const Deps extends readonly RouteDependency[]>(
  pattern: RegExp,
  dependencies: Deps,
  handle: DynamicRouteHandler<Deps>,
): DynamicRouteDefinition {
  return {
    pattern,
    dependencies,
    handle: handle as DynamicRouteDefinition["handle"],
  };
}
