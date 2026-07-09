import type { SchemaLikeSource } from "@/lib/schema-like";

export interface FrontendApiQueryBaseDescriptor {
  queryKey: readonly unknown[];
  path: string;
  producerIntervalMs: number;
  metaMaxAgeSec?: number;
}

export interface FrontendStaticApiQueryBaseDescriptor {
  queryKey: readonly unknown[];
  path: string;
}

export type FrontendApiQueryResponseMode = "plain" | "meta";

export interface FrontendApiQueryDescriptor<
  T,
  TMode extends FrontendApiQueryResponseMode = FrontendApiQueryResponseMode,
> extends FrontendApiQueryBaseDescriptor {
  responseMode: TMode;
  schema?: SchemaLikeSource<T>;
}

export interface FrontendStaticApiQueryDescriptor<T> extends FrontendStaticApiQueryBaseDescriptor {
  responseMode: "static";
  schema?: SchemaLikeSource<T>;
}

export type FrontendAnyApiQueryDescriptor =
  | FrontendApiQueryDescriptor<unknown>
  | FrontendStaticApiQueryDescriptor<unknown>;

export function defineApiQuery<
  TBase extends FrontendApiQueryBaseDescriptor,
  TData,
  TMode extends FrontendApiQueryResponseMode,
>(
  base: TBase,
  responseMode: TMode,
  schema: SchemaLikeSource<TData>,
): TBase & FrontendApiQueryDescriptor<TData, TMode> {
  return { ...base, responseMode, schema };
}

function defineStaticApiQuery<
  TBase extends FrontendStaticApiQueryBaseDescriptor,
  TData,
>(
  base: TBase,
  schema: SchemaLikeSource<TData>,
): TBase & FrontendStaticApiQueryDescriptor<TData> {
  return { ...base, responseMode: "static", schema };
}

export function defineParameterizedApiQuery<
  TArgs extends unknown[],
  TBase extends FrontendApiQueryBaseDescriptor,
  TData,
  TMode extends FrontendApiQueryResponseMode,
>(
  responseMode: TMode,
  schema: SchemaLikeSource<TData>,
  buildBase: (...args: TArgs) => TBase,
): (...args: TArgs) => TBase & FrontendApiQueryDescriptor<TData, TMode> {
  return (...args) => defineApiQuery(buildBase(...args), responseMode, schema);
}

export function defineParameterizedStaticApiQuery<
  TArgs extends unknown[],
  TBase extends FrontendStaticApiQueryBaseDescriptor,
  TData,
>(
  schema: SchemaLikeSource<TData>,
  buildBase: (...args: TArgs) => TBase,
): (...args: TArgs) => TBase & FrontendStaticApiQueryDescriptor<TData> {
  return (...args) => defineStaticApiQuery(buildBase(...args), schema);
}

type BaseDescriptorFor<TDescriptor> =
  TDescriptor extends FrontendApiQueryDescriptor<unknown>
    ? FrontendApiQueryBaseDescriptor
    : TDescriptor extends FrontendStaticApiQueryDescriptor<unknown>
      ? FrontendStaticApiQueryBaseDescriptor
      : never;

type BaseRegistryEntry<TEntry> = TEntry extends (...args: infer TArgs) => infer TDescriptor
  ? (...args: TArgs) => BaseDescriptorFor<TDescriptor>
  : BaseDescriptorFor<TEntry>;

export type FrontendApiQueryBaseRegistry<TRegistry extends Record<string, unknown>> = {
  readonly [TKey in keyof TRegistry]: BaseRegistryEntry<TRegistry[TKey]>;
};

export function toBaseApiQueryDescriptor(
  descriptor: FrontendAnyApiQueryDescriptor,
): FrontendApiQueryBaseDescriptor | FrontendStaticApiQueryBaseDescriptor {
  const { responseMode: _responseMode, schema: _schema, ...base } = descriptor;
  return base;
}

export function createBaseApiQueryRegistry<TRegistry extends Record<string, unknown>>(
  registry: TRegistry,
): FrontendApiQueryBaseRegistry<TRegistry> {
  const projected: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(registry)) {
    if (typeof entry === "function") {
      const buildDescriptor = entry as unknown as (...args: unknown[]) => FrontendAnyApiQueryDescriptor;
      projected[key] = (...args: unknown[]) => toBaseApiQueryDescriptor(buildDescriptor(...args));
    } else {
      projected[key] = toBaseApiQueryDescriptor(entry as FrontendAnyApiQueryDescriptor);
    }
  }

  return projected as FrontendApiQueryBaseRegistry<TRegistry>;
}
