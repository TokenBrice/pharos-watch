import { toErrorMessage } from "@shared/lib/error-utils";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import type {
  Abi,
  AbiFunction,
  AbiParametersToPrimitiveTypes,
  AbiStateMutability,
  ExtractAbiFunction,
  ExtractAbiFunctionNames,
} from "abitype";
import { decodeFunctionResult, encodeFunctionData } from "viem/utils";
import type { EvmRpcOptions } from "../../lib/evm-rpc";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { EIP1967_IMPLEMENTATION_SLOT, implementationAddressFromSlot } from "./onchain-identity";
import { normalizeEvmAddress } from "./evm";

export interface EvmObservationTransportCall {
  label: string;
  contract: string;
  data: string;
  allowFailure?: boolean;
}

export interface EvmObservationTransportResult {
  label: string;
  success: boolean;
  returnData: `0x${string}`;
}

type ObservationDecoder<T> = (raw: `0x${string}`, label: string) => T;
type ObservationVerifier<T, Values> = (value: T, values: Values) => string | null;
type ObservationWarning<T, Values> = (
  value: T,
  values: Values,
) => LiveReserveWarning | readonly LiveReserveWarning[] | null | undefined;

export interface EvmObservationField<
  Label extends string = string,
  Value = unknown,
  Optional extends boolean = boolean,
> extends EvmObservationTransportCall {
  label: Label;
  optional?: Optional;
  decode: ObservationDecoder<Value>;
  verify?: ObservationVerifier<Value, Record<string, unknown>>;
  warning?: ObservationWarning<Value, Record<string, unknown>>;
  metadata?: string | { key: string; project: (value: Value) => unknown };
}

// `any` is intentional at the heterogeneous tuple boundary. `FieldValue`
// immediately recovers each descriptor's concrete decoder type below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEvmObservationField = EvmObservationField<string, any, boolean>;
type FieldValue<Field extends AnyEvmObservationField> =
  true extends Field["optional"]
    ? ReturnType<Field["decode"]> | null
    : ReturnType<Field["decode"]>;

export type EvmObservationValues<Fields extends readonly AnyEvmObservationField[]> = {
  [Label in Fields[number]["label"]]: FieldValue<Extract<Fields[number], { label: Label }>>;
};

export interface EvmObservationSnapshot<Fields extends readonly AnyEvmObservationField[], Anchor = undefined> {
  values: EvmObservationValues<Fields>;
  warnings: LiveReserveWarning[];
  metadata: Record<string, unknown>;
  rawByLabel: ReadonlyMap<string, `0x${string}`>;
  anchor: Anchor;
}

export interface EvmObservationAnchor<Anchor> {
  observe: () => Promise<Anchor | null>;
  verify?: (anchor: Anchor) => string | null;
  metadata?: (anchor: Anchor) => Record<string, unknown>;
}

export interface EvmObservationCheck<Anchor, Value> {
  label: string;
  observe: (anchor: Anchor) => Promise<Value | null>;
  verify: (value: Value, anchor: Anchor) => string | null;
  metadata?: string | { key: string; project: (value: Value) => unknown };
}

export interface EvmObservationPlan<
  Fields extends readonly AnyEvmObservationField[],
  Anchor = undefined,
> {
  adapterKey: string;
  fields: Fields;
  anchor?: EvmObservationAnchor<Anchor>;
  checks?: readonly EvmObservationCheck<Anchor, unknown>[];
  onFailure?: (label: string) => never;
  onDecodeError?: (error: unknown, label: string) => never;
  read: (
    calls: readonly EvmObservationTransportCall[],
    anchor: Anchor,
  ) => Promise<readonly EvmObservationTransportResult[] | null>;
}

interface FieldOptionsBase<Label extends string, Value> {
  label: Label;
  contract: string;
  data: string;
  allowFailure?: boolean;
  verify?: ObservationVerifier<Value, Record<string, unknown>>;
  warning?: ObservationWarning<Value, Record<string, unknown>>;
  metadata?: string | { key: string; project: (value: Value) => unknown };
}

type ObservationOptional<Optional extends boolean | undefined> =
  Optional extends true ? true : Optional extends false | undefined ? false : boolean;

function defineField<Label extends string, Value, Optional extends boolean | undefined>(
  options: FieldOptionsBase<Label, Value> & { optional?: Optional },
  decode: ObservationDecoder<Value>,
): EvmObservationField<Label, Value, ObservationOptional<Optional>> {
  return { ...options, decode } as EvmObservationField<Label, Value, ObservationOptional<Optional>>;
}

export function rawObservation<
  const Label extends string,
  const Optional extends boolean | undefined = undefined,
>(
  options: FieldOptionsBase<Label, `0x${string}`> & { optional?: Optional },
): EvmObservationField<Label, `0x${string}`, ObservationOptional<Optional>> {
  return defineField(options, (raw) => raw);
}

export function uint256Observation<
  const Label extends string,
  const Optional extends boolean | undefined = undefined,
>(
  options: FieldOptionsBase<Label, bigint> & { optional?: Optional },
): EvmObservationField<Label, bigint, ObservationOptional<Optional>> {
  return defineField(options, (raw, label) => {
    const value = decodeUint256Word(raw);
    if (value == null) throw new Error(`${label} returned malformed uint256 payload`);
    return value;
  });
}

export function boolObservation<
  const Label extends string,
  const Optional extends boolean | undefined = undefined,
>(
  options: FieldOptionsBase<Label, boolean> & { optional?: Optional },
): EvmObservationField<Label, boolean, ObservationOptional<Optional>> {
  return defineField(options, (raw, label) => {
    const value = decodeStrictBoolWord(raw);
    if (value == null) throw new Error(`${label} returned malformed bool payload`);
    return value;
  });
}

export function addressObservation<
  const Label extends string,
  const Optional extends boolean | undefined = undefined,
>(
  options: FieldOptionsBase<Label, string> & { optional?: Optional },
): EvmObservationField<Label, string, ObservationOptional<Optional>> {
  return defineField(options, (raw, label) => {
    const value = decodeStrictAddressWord(raw);
    if (value == null) throw new Error(`${label} returned malformed address payload`);
    return value.toLowerCase();
  });
}

export function customObservation<
  const Label extends string,
  Value,
  const Optional extends boolean | undefined = undefined,
>(
  options: FieldOptionsBase<Label, Value> & {
    optional?: Optional;
    decode: ObservationDecoder<Value>;
  },
): EvmObservationField<Label, Value, ObservationOptional<Optional>> {
  const { decode, ...field } = options;
  return defineField(field, decode);
}

type AbiObservationValue<
  AbiType extends Abi | readonly unknown[],
  FunctionName extends ContractFunctionName<AbiType>,
  Args extends ContractFunctionArgs<AbiType, AbiStateMutability, FunctionName>,
> = AbiType extends Abi
  ? Abi extends AbiType
    ? unknown
    : AbiParametersToPrimitiveTypes<
        AbiFunctionForArgs<AbiType, FunctionName, Args>["outputs"],
        "outputs",
        true
      > extends infer Types
      ? Types extends readonly []
        ? void
        : Types extends readonly [infer Type]
          ? Type
          : Types
      : unknown
  : unknown;

type AbiFunctionForArgs<
  AbiType extends Abi | readonly unknown[],
  FunctionName extends ContractFunctionName<AbiType>,
  Args extends ContractFunctionArgs<AbiType, AbiStateMutability, FunctionName>,
> = ExtractAbiFunction<AbiType extends Abi ? AbiType : Abi, FunctionName, AbiStateMutability> extends infer Function
  ? Function extends AbiFunction
    ? (readonly [] extends Args ? readonly [] : Args) extends AbiParametersToPrimitiveTypes<
        Function["inputs"],
        "inputs",
        true
      >
      ? Function
      : never
    : never
  : never;

type ContractFunctionName<
  AbiType extends Abi | readonly unknown[],
  Mutability extends AbiStateMutability = AbiStateMutability,
> = ExtractAbiFunctionNames<AbiType extends Abi ? AbiType : Abi, Mutability> extends infer FunctionName extends string
  ? [FunctionName] extends [never]
    ? string
    : FunctionName
  : string;

type ContractFunctionArgs<
  AbiType extends Abi | readonly unknown[],
  Mutability extends AbiStateMutability,
  FunctionName extends ContractFunctionName<AbiType, Mutability>,
> = AbiParametersToPrimitiveTypes<
  ExtractAbiFunction<AbiType extends Abi ? AbiType : Abi, FunctionName, Mutability>["inputs"],
  "inputs",
  true
> extends infer Args
  ? [Args] extends [never]
    ? readonly unknown[]
    : Args
  : readonly unknown[];

export function abiObservation<
  const Label extends string,
  const AbiType extends Abi | readonly unknown[],
  const FunctionName extends ContractFunctionName<AbiType>,
  const Args extends ContractFunctionArgs<AbiType, AbiStateMutability, FunctionName> = ContractFunctionArgs<
    AbiType,
    AbiStateMutability,
    FunctionName
  >,
  const Optional extends boolean | undefined = undefined,
>(
  options: Omit<
    FieldOptionsBase<Label, AbiObservationValue<AbiType, FunctionName, Args>>,
    "data"
  > & {
    abi: AbiType;
    functionName: FunctionName;
    args?: Args;
    optional?: Optional;
  },
): EvmObservationField<
  Label,
  AbiObservationValue<AbiType, FunctionName, Args>,
  ObservationOptional<Optional>
> {
  const { abi, functionName, args, ...field } = options;
  const encodeOptions = {
    abi,
    functionName,
    ...(args != null ? { args } : {}),
  } as Parameters<typeof encodeFunctionData>[0];
  const decodeOptions = {
    abi,
    functionName,
    ...(args != null ? { args } : {}),
  } as Omit<Parameters<typeof decodeFunctionResult>[0], "data">;
  return defineField(
    {
      ...field,
      data: encodeFunctionData(encodeOptions),
      allowFailure: field.allowFailure ?? false,
    },
    (raw) => decodeFunctionResult({ ...decodeOptions, data: raw }) as AbiObservationValue<AbiType, FunctionName, Args>,
  );
}

export interface EvmCodeIdentity {
  address: string;
  codeHash: string;
  implementationAddress?: string;
  implementationCodeHash?: string;
}

export type EvmCodeIdentityRejectionCode =
  | "code-unavailable"
  | "code-drift"
  | "implementation-unavailable"
  | "implementation-drift";

export type EvmCodeIdentityCheckResult =
  | { status: "accepted" }
  | {
      status: "rejected";
      rejectionCode: EvmCodeIdentityRejectionCode;
      address: string;
      kind: "contract" | "implementation" | "storage";
    };

type EvmCodeIdentityKind = "contract" | "implementation";

export interface EvmCodeIdentityCheckOptions<Client, Identity extends EvmCodeIdentity> {
  blockNumber: number | ((identity: Identity) => number);
  rpcOptions: EvmRpcOptions | ((identity: Identity) => EvmRpcOptions);
  readCode: (
    client: Client,
    address: string,
    blockNumber: number,
    rpcOptions: EvmRpcOptions,
    identity: Identity,
    kind: EvmCodeIdentityKind,
  ) => Promise<string | null>;
  readStorage: (
    client: Client,
    address: string,
    slot: string,
    blockNumber: number,
    rpcOptions: EvmRpcOptions,
    identity: Identity,
  ) => Promise<`0x${string}` | null>;
  hashCode?: (code: string) => string | null;
  run?: <Value>(label: string, factory: () => Promise<Value>) => Promise<Value>;
  codeLabel?: (identity: Identity, kind: EvmCodeIdentityKind) => string;
  storageLabel?: (identity: Identity) => string;
  parallel?: boolean;
}

/**
 * Check direct and EIP-1967 proxy identities with the caller's transport.
 * Parallel mode retains the two-phase read shape used by multi-chain routes;
 * the default sequential mode retains the fail-fast executable-route shape.
 */
export async function codeIdentityChecks<
  Client,
  const Identity extends EvmCodeIdentity,
>(
  client: Client,
  identities: readonly Identity[],
  options: EvmCodeIdentityCheckOptions<Client, Identity>,
): Promise<EvmCodeIdentityCheckResult> {
  const run = <Value>(label: string, factory: () => Promise<Value>) =>
    options.run ? options.run(label, factory) : factory();
  const blockNumber = (identity: Identity) =>
    typeof options.blockNumber === "function" ? options.blockNumber(identity) : options.blockNumber;
  const rpcOptions = (identity: Identity) =>
    typeof options.rpcOptions === "function" ? options.rpcOptions(identity) : options.rpcOptions;
  const codeLabel = (identity: Identity, kind: EvmCodeIdentityKind) =>
    options.codeLabel?.(identity, kind) ?? `${identity.address}-${kind}-code`;
  const storageLabel = (identity: Identity) =>
    options.storageLabel?.(identity) ?? `${identity.address}-implementation`;
  const hasImplementationCode = (identity: Identity): identity is Identity & {
    implementationAddress: string;
  } => identity.implementationAddress != null;
  const hasProxyIdentity = (identity: Identity): identity is Identity & {
    implementationAddress: string;
    implementationCodeHash: string;
  } => identity.implementationAddress != null && identity.implementationCodeHash != null;
  const codeEntries = identities.flatMap((identity) => [
    { identity, kind: "contract" as const, address: identity.address },
    ...(hasImplementationCode(identity)
      ? [{ identity, kind: "implementation" as const, address: identity.implementationAddress }]
      : []),
  ]);
  const readCode = async (entry: (typeof codeEntries)[number]) => {
    const block = blockNumber(entry.identity);
    const rpc = rpcOptions(entry.identity);
    const code = await run(
      codeLabel(entry.identity, entry.kind),
      () => options.readCode(client, entry.address, block, rpc, entry.identity, entry.kind),
    );
    return { ...entry, code };
  };
  const inspectCode = (
    entry: (typeof codeEntries)[number],
    code: string | null,
  ): EvmCodeIdentityCheckResult | null => {
    if (code == null) {
      return {
        status: "rejected",
        rejectionCode: "code-unavailable",
        address: entry.address,
        kind: entry.kind,
      };
    }
    const expectedHash = entry.kind === "implementation"
      ? entry.identity.implementationCodeHash
      : entry.identity.codeHash;
    const actualHash = options.hashCode ? options.hashCode(code) : code.toLowerCase();
    if (!expectedHash || actualHash !== expectedHash.toLowerCase()) {
      return {
        status: "rejected",
        rejectionCode: entry.kind === "implementation" ? "implementation-drift" : "code-drift",
        address: entry.address,
        kind: entry.kind,
      };
    }
    return null;
  };

  const proxies = identities.filter(hasProxyIdentity);
  const readSlot = async (identity: (typeof proxies)[number]) => {
    const block = blockNumber(identity);
    const rpc = rpcOptions(identity);
    const slot = await run(
      storageLabel(identity),
      () => options.readStorage(
        client,
        identity.address,
        EIP1967_IMPLEMENTATION_SLOT,
        block,
        rpc,
        identity,
      ),
    );
    return { identity, slot };
  };
  const inspectSlot = (
    identity: (typeof proxies)[number],
    slot: `0x${string}` | null,
  ): EvmCodeIdentityCheckResult | null => {
    const actualAddress = implementationAddressFromSlot(slot);
    if (actualAddress == null) {
      return {
        status: "rejected",
        rejectionCode: "implementation-unavailable",
        address: identity.address,
        kind: "storage",
      };
    }
    if (actualAddress !== normalizeEvmAddress(identity.implementationAddress)) {
      return {
        status: "rejected",
        rejectionCode: "implementation-drift",
        address: identity.address,
        kind: "storage",
      };
    }
    return null;
  };

  if (options.parallel) {
    const observedCodes = await Promise.all(codeEntries.map(readCode));
    const unavailable = observedCodes.find((entry) => entry.code == null);
    if (unavailable) {
      return inspectCode(unavailable, unavailable.code)!;
    }
    for (const entry of observedCodes) {
      const failure = inspectCode(entry, entry.code);
      if (failure) return failure;
    }
    const observedSlots = await Promise.all(proxies.map(readSlot));
    const unavailableSlot = observedSlots.find(({ slot }) => implementationAddressFromSlot(slot) == null);
    if (unavailableSlot) {
      return inspectSlot(unavailableSlot.identity, unavailableSlot.slot)!;
    }
    for (const { identity, slot } of observedSlots) {
      const failure = inspectSlot(identity, slot);
      if (failure) return failure;
    }
  } else {
    for (const identity of identities) {
      const observed = await readCode({ identity, kind: "contract", address: identity.address });
      let failure = inspectCode(observed, observed.code);
      if (failure) return failure;
      if (hasProxyIdentity(identity)) {
        const observedSlot = await readSlot(identity);
        failure = inspectSlot(identity, observedSlot.slot);
        if (failure) return failure;
        const implementation = await readCode({
          identity,
          kind: "implementation",
          address: identity.implementationAddress,
        });
        failure = inspectCode(implementation, implementation.code);
        if (failure) return failure;
      }
    }
  }
  return { status: "accepted" };
}

function appendWarnings(
  target: LiveReserveWarning[],
  warning: LiveReserveWarning | readonly LiveReserveWarning[] | null | undefined,
): void {
  if (warning == null) return;
  if (Array.isArray(warning)) target.push(...warning);
  else target.push(warning as LiveReserveWarning);
}

/**
 * Execute the shared state machine around an adapter-owned EVM transport.
 * The caller still owns retry, fallback, deadlines, block selection, and I/O
 * limiting; this layer owns the deterministic labeled observation lifecycle.
 */
export async function executeEvmObservationPlan<
  const Fields extends readonly AnyEvmObservationField[],
  Anchor = undefined,
>(
  plan: EvmObservationPlan<Fields, Anchor>,
): Promise<EvmObservationSnapshot<Fields, Anchor>> {
  const labels = new Set<string>();
  for (const field of plan.fields) {
    if (!field.label || labels.has(field.label)) {
      throw new Error(`${plan.adapterKey} observation plan has duplicate or empty label: ${field.label}`);
    }
    labels.add(field.label);
  }

  let anchor: Anchor;
  if (plan.anchor) {
    const observedAnchor = await plan.anchor.observe();
    if (observedAnchor == null) throw new Error(`${plan.adapterKey} observation block anchor failed`);
    const anchorError = plan.anchor.verify?.(observedAnchor);
    if (anchorError) throw new Error(`${plan.adapterKey} observation block anchor invalid: ${anchorError}`);
    anchor = observedAnchor;
  } else {
    anchor = undefined as Anchor;
  }

  const metadata: Record<string, unknown> = {
    ...(plan.anchor?.metadata?.(anchor) ?? {}),
  };
  for (const check of plan.checks ?? []) {
    const value = await check.observe(anchor);
    if (value == null) throw new Error(`${plan.adapterKey} observation check failed: ${check.label}`);
    const checkError = check.verify(value, anchor);
    if (checkError) throw new Error(`${plan.adapterKey} observation check failed for ${check.label}: ${checkError}`);
    if (typeof check.metadata === "string") metadata[check.metadata] = value;
    else if (check.metadata) metadata[check.metadata.key] = check.metadata.project(value);
  }

  const results = await plan.read(plan.fields.map(({ label, contract, data, allowFailure }) => ({
    label,
    contract,
    data,
    ...(allowFailure != null ? { allowFailure } : {}),
  })), anchor);
  if (results == null) throw new Error(`${plan.adapterKey} observation transport failed`);
  if (results.length !== plan.fields.length) {
    throw new Error(
      `${plan.adapterKey} observation result count mismatch: ${results.length} != ${plan.fields.length}`,
    );
  }

  const resultByLabel = new Map<string, EvmObservationTransportResult>();
  for (const result of results) {
    if (!labels.has(result.label)) {
      throw new Error(`${plan.adapterKey} observation returned unknown label: ${result.label}`);
    }
    if (resultByLabel.has(result.label)) {
      throw new Error(`${plan.adapterKey} observation returned duplicate label: ${result.label}`);
    }
    resultByLabel.set(result.label, result);
  }

  const values: Record<string, unknown> = {};
  const rawByLabel = new Map<string, `0x${string}`>();
  for (const field of plan.fields) {
    const result = resultByLabel.get(field.label);
    if (!result) {
      plan.onFailure?.(field.label);
      throw new Error(`${plan.adapterKey} observation missing result: ${field.label}`);
    }
    if (!result.success || result.returnData === "0x") {
      if (field.optional === true) {
        values[field.label] = null;
        continue;
      }
      plan.onFailure?.(field.label);
      throw new Error(`${plan.adapterKey} observation failed: ${field.label}`);
    }
    rawByLabel.set(field.label, result.returnData);
    try {
      values[field.label] = field.decode(result.returnData, field.label);
    } catch (error) {
      plan.onDecodeError?.(error, field.label);
      const message = toErrorMessage(error);
      throw new Error(`${plan.adapterKey} observation decode failed for ${field.label}: ${message}`);
    }
  }

  const warnings: LiveReserveWarning[] = [];
  for (const field of plan.fields) {
    const value = values[field.label];
    if (value == null) continue;
    const verificationError = field.verify?.(value, values);
    if (verificationError) {
      throw new Error(`${plan.adapterKey} observation identity failed for ${field.label}: ${verificationError}`);
    }
    appendWarnings(warnings, field.warning?.(value, values));
    if (typeof field.metadata === "string") metadata[field.metadata] = value;
    else if (field.metadata) metadata[field.metadata.key] = field.metadata.project(value);
  }

  return {
    values: values as EvmObservationValues<Fields>,
    warnings,
    metadata,
    rawByLabel,
    anchor,
  };
}
