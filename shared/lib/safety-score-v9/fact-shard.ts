import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { V9AssetFactsV3 } from "../../types/safety-score-v9-facts";
import { deepFreeze } from "../../types/safety-score-v9-immutable";

// Weak keys never retain an invocation's views. The immutable view owns its
// shard through its getters; this index only avoids encoding it a second time.
const factShardsByView = new WeakMap<object, Uint8Array>();

// Invocation-private transport for already admitted facts, not a storage/wire
// codec. Facts deliberately share evidence/status subgraphs: ordinary JSON
// expands every occurrence and can exceed the original graph by orders of magnitude.
// Nonnegative references address objects; -1 is undefined; lower references
// address interned strings. Object nodes alternate string-key indexes and values.
type Reference = [number];
type Value = number | boolean | null | Reference;
type Node = [0 | 1, ...Value[]];

export function serializeV9FactShard(asset: V9AssetFactsV3): Uint8Array {
  const existing = factShardsByView.get(asset);
  // Transport callers own mutable bytes; never expose an admitted view's backing store.
  if (existing !== undefined) return existing.slice();
  const references = new WeakMap<object, number>();
  const nodes: Node[] = [];
  const strings: string[] = [];
  const stringIndexes = new Map<string, number>();
  function stringIndex(value: string): number {
    const prior = stringIndexes.get(value);
    if (prior !== undefined) return prior;
    const index = strings.length;
    strings.push(value);
    stringIndexes.set(value, index);
    return index;
  }
  function encode(value: unknown): Value {
    if (value === undefined) return [-1];
    if (typeof value === "string") return [-2 - stringIndex(value)];
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") throw new Error("Admitted V9 facts contain a non-JSON value");
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Admitted V9 facts contain a non-plain object");
      }
    }
    const prior = references.get(value);
    if (prior !== undefined) return [prior];
    const index = nodes.length;
    references.set(value, index);
    const node: Node = [Array.isArray(value) ? 0 : 1];
    nodes.push(node);
    if (Array.isArray(value)) {
      for (const item of value) node.push(encode(item));
    } else {
      for (const key of Object.keys(value)) {
        node.push(stringIndex(key), encode((value as Record<string, unknown>)[key]));
      }
    }
    return [index];
  }
  encode(asset);
  return deflateSync(strToU8(JSON.stringify([strings, nodes])), { level: 1 });
}

export function deserializeV9FactShard(shard: Uint8Array): V9AssetFactsV3 {
  // Only serializeV9FactShard's owned output reaches this function. External
  // inputs must still pass the compiled-fact schema and identity admission.
  const [strings, nodes]: [string[], Node[]] = JSON.parse(strFromU8(inflateSync(shard)));
  const objects: Array<unknown[] | Record<string, unknown>> =
    nodes.map((node) => node[0] === 0 ? [] : {});
  function decode(value: Value): unknown {
    if (!Array.isArray(value)) return value;
    const index = value[0];
    return index === -1 ? undefined : index < -1 ? strings[-2 - index] : objects[index];
  }
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const object = objects[index]!;
    if (node[0] === 0) {
      const array = object as unknown[];
      for (let item = 1; item < node.length; item++) array.push(decode(node[item]!));
    } else {
      const record = object as Record<string, unknown>;
      for (let item = 1; item < node.length; item += 2) {
        Object.defineProperty(record, strings[node[item] as number]!, {
          value: decode(node[item + 1]!), enumerable: true, writable: true, configurable: true,
        });
      }
    }
  }
  return objects[0] as V9AssetFactsV3;
}

function shardFieldGetter(
  read: (shard: Uint8Array) => V9AssetFactsV3,
  shard: Uint8Array,
  key: keyof V9AssetFactsV3,
): () => V9AssetFactsV3[keyof V9AssetFactsV3] {
  // This closure must not capture the original admitted asset.
  return () => read(shard)[key];
}

/** Private immutable representation; the compiler owns admission of each view. */
export function createV9FactShardViewFactory(): (asset: V9AssetFactsV3) => V9AssetFactsV3 {
  // One decoded asset per compiler invocation, not one cache per getter/asset.
  let cachedShard: Uint8Array | null = null;
  let cachedAsset: V9AssetFactsV3 | null = null;
  function read(shard: Uint8Array): V9AssetFactsV3 {
    if (cachedShard !== shard) {
      cachedAsset = deepFreeze(deserializeV9FactShard(shard));
      cachedShard = shard;
    }
    return cachedAsset!;
  }
  return (asset) => {
    const shard = serializeV9FactShard(asset);
    const descriptors: PropertyDescriptorMap = {};
    for (const key of Object.keys(asset) as Array<keyof V9AssetFactsV3>) {
      const value = asset[key];
      descriptors[key] = value !== null && typeof value === "object"
        ? { enumerable: true, get: shardFieldGetter(read, shard, key) }
        : { enumerable: true, value };
    }
    const view = Object.freeze(Object.defineProperties({}, descriptors)) as V9AssetFactsV3;
    factShardsByView.set(view, shard);
    return view;
  };
}
