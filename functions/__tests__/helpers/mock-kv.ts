import type { KVNamespace, KVNamespaceGetOptions } from "@shared/types/cloudflare-runtime";

export interface RecordedPutCall {
  key: string;
  options?: { expirationTtl?: number; metadata?: unknown };
}

export interface TestKVTextStore {
  get(key: string): string | undefined;
  set(key: string, value: string): TestKVTextStore;
  has(key: string): boolean;
  readonly size: number;
}

/**
 * In-memory KVNamespace stub for Pages Functions suites.
 *
 * Beyond the namespace surface it records every `put` (key plus the raw
 * `expirationTtl`/`metadata` options, which retention and trust-attestation
 * assertions read back) and lets a suite swap in read/write handlers to drive
 * corrupt-value and unavailable-binding failure paths.
 */
export interface TestKVNamespace extends KVNamespace {
  __getStore(): TestKVTextStore;
  __getPutCalls(): RecordedPutCall[];
  __setReadHandler(handler: ((key: string) => string | null | Promise<string | null>) | null): void;
  __setWriteHandler(handler: ((key: string, value: string) => void | Promise<void>) | null): void;
  /**
   * Seed a binary value, for suites reading with `{ type: "arrayBuffer" }`.
   * Text and binary values share a key space; a text value read as an
   * arrayBuffer comes back UTF-8 encoded, as it would from real KV.
   */
  __putBinary(key: string, bytes: Uint8Array): void;
}

export function makeKV(): TestKVNamespace {
  const store = new Map<string, { value: string | Uint8Array; metadata: unknown }>();
  const putCalls: RecordedPutCall[] = [];
  let readHandler: ((key: string) => string | null | Promise<string | null>) | null = null;
  let writeHandler: ((key: string, value: string) => void | Promise<void>) | null = null;
  const textValue = (key: string): string | undefined => {
    const entry = store.get(key);
    return entry === undefined ? undefined
      : typeof entry.value === "string" ? entry.value : new TextDecoder().decode(entry.value);
  };
  const textStore: TestKVTextStore = {
    get: textValue,
    set: (key, value) => {
      store.set(key, { value, metadata: null });
      return textStore;
    },
    has: (key) => store.has(key),
    get size() { return store.size; },
  };

  const readValue = async (key: string): Promise<string | null> => {
    if (readHandler) {
      return readHandler(key);
    }
    return textValue(key) ?? null;
  };

  const readArrayBuffer = async (key: string): Promise<ArrayBuffer | null> => {
    const value = store.get(key)?.value;
    if (!readHandler && value instanceof Uint8Array) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    }
    const text = await readValue(key);
    return text === null ? null : (new TextEncoder().encode(text).buffer as ArrayBuffer);
  };

  const ns: Partial<TestKVNamespace> = {
    get: (async (key: string, options?: KVNamespaceGetOptions<"text" | "arrayBuffer">) => {
      const type = typeof options === "string" ? options : options?.type;
      if (type === "arrayBuffer") {
        return readArrayBuffer(key);
      }
      return readValue(key);
    }) as KVNamespace["get"],
    getWithMetadata: (async (key: string, _options?: KVNamespaceGetOptions<"text">) => {
      return { value: await readValue(key), metadata: store.get(key)?.metadata ?? null, cacheStatus: null };
    }) as KVNamespace["getWithMetadata"],
    put: (async (key: string, value: string, options?: RecordedPutCall["options"]) => {
      if (writeHandler) {
        await writeHandler(key, value);
      }
      store.set(key, { value, metadata: options?.metadata ?? null });
      putCalls.push({ key, options });
    }) as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as KVNamespace["delete"],
    list: (async () => ({ keys: [], list_complete: true, cacheStatus: null })) as KVNamespace["list"],
    __getStore: () => textStore,
    __getPutCalls: () => putCalls,
    __setReadHandler: (handler) => {
      readHandler = handler;
    },
    __setWriteHandler: (handler) => {
      writeHandler = handler;
    },
    __putBinary: (key, bytes) => {
      store.set(key, { value: bytes.slice(), metadata: null });
    },
  };

  return ns as TestKVNamespace;
}
