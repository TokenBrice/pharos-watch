import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";

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

type RequiredFieldOptions<Label extends string, Value> = FieldOptionsBase<Label, Value> & { optional?: false };
type OptionalFieldOptions<Label extends string, Value> = FieldOptionsBase<Label, Value> & { optional: true };
type AnyFieldOptions<Label extends string, Value> = FieldOptionsBase<Label, Value> & { optional?: boolean };

function defineField<Label extends string, Value>(
  options: AnyFieldOptions<Label, Value>,
  decode: ObservationDecoder<Value>,
): EvmObservationField<Label, Value, boolean> {
  return { ...options, decode };
}

export function rawObservation<const Label extends string>(
  options: RequiredFieldOptions<Label, `0x${string}`>,
): EvmObservationField<Label, `0x${string}`, false>;
export function rawObservation<const Label extends string>(
  options: OptionalFieldOptions<Label, `0x${string}`>,
): EvmObservationField<Label, `0x${string}`, true>;
export function rawObservation<const Label extends string>(
  options: AnyFieldOptions<Label, `0x${string}`>,
): EvmObservationField<Label, `0x${string}`, boolean>;
export function rawObservation<Label extends string>(
  options: AnyFieldOptions<Label, `0x${string}`>,
): EvmObservationField<Label, `0x${string}`, boolean> {
  return defineField(options, (raw) => raw);
}

export function uint256Observation<const Label extends string>(
  options: RequiredFieldOptions<Label, bigint>,
): EvmObservationField<Label, bigint, false>;
export function uint256Observation<const Label extends string>(
  options: OptionalFieldOptions<Label, bigint>,
): EvmObservationField<Label, bigint, true>;
export function uint256Observation<const Label extends string>(
  options: AnyFieldOptions<Label, bigint>,
): EvmObservationField<Label, bigint, boolean>;
export function uint256Observation<Label extends string>(
  options: AnyFieldOptions<Label, bigint>,
): EvmObservationField<Label, bigint, boolean> {
  return defineField(options, (raw, label) => {
    const value = decodeUint256Word(raw);
    if (value == null) throw new Error(`${label} returned malformed uint256 payload`);
    return value;
  });
}

export function boolObservation<const Label extends string>(
  options: RequiredFieldOptions<Label, boolean>,
): EvmObservationField<Label, boolean, false>;
export function boolObservation<const Label extends string>(
  options: OptionalFieldOptions<Label, boolean>,
): EvmObservationField<Label, boolean, true>;
export function boolObservation<const Label extends string>(
  options: AnyFieldOptions<Label, boolean>,
): EvmObservationField<Label, boolean, boolean>;
export function boolObservation<Label extends string>(
  options: AnyFieldOptions<Label, boolean>,
): EvmObservationField<Label, boolean, boolean> {
  return defineField(options, (raw, label) => {
    const value = decodeStrictBoolWord(raw);
    if (value == null) throw new Error(`${label} returned malformed bool payload`);
    return value;
  });
}

export function addressObservation<const Label extends string>(
  options: RequiredFieldOptions<Label, string>,
): EvmObservationField<Label, string, false>;
export function addressObservation<const Label extends string>(
  options: OptionalFieldOptions<Label, string>,
): EvmObservationField<Label, string, true>;
export function addressObservation<const Label extends string>(
  options: AnyFieldOptions<Label, string>,
): EvmObservationField<Label, string, boolean>;
export function addressObservation<Label extends string>(
  options: AnyFieldOptions<Label, string>,
): EvmObservationField<Label, string, boolean> {
  return defineField(options, (raw, label) => {
    const value = decodeStrictAddressWord(raw);
    if (value == null) throw new Error(`${label} returned malformed address payload`);
    return value.toLowerCase();
  });
}

export function customObservation<
  const Label extends string,
  Value,
>(
  options: RequiredFieldOptions<Label, Value> & { decode: ObservationDecoder<Value> },
): EvmObservationField<Label, Value, false>;
export function customObservation<
  const Label extends string,
  Value,
>(
  options: OptionalFieldOptions<Label, Value> & { decode: ObservationDecoder<Value> },
): EvmObservationField<Label, Value, true>;
export function customObservation<
  const Label extends string,
  Value,
>(
  options: AnyFieldOptions<Label, Value> & { decode: ObservationDecoder<Value> },
): EvmObservationField<Label, Value, boolean>;
export function customObservation<Label extends string, Value>(
  options: AnyFieldOptions<Label, Value> & { decode: ObservationDecoder<Value> },
): EvmObservationField<Label, Value, boolean> {
  const { decode, ...field } = options;
  return defineField(field, decode);
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
    if (!result) throw new Error(`${plan.adapterKey} observation missing result: ${field.label}`);
    if (!result.success || result.returnData === "0x") {
      if (field.optional === true) {
        values[field.label] = null;
        continue;
      }
      throw new Error(`${plan.adapterKey} observation failed: ${field.label}`);
    }
    rawByLabel.set(field.label, result.returnData);
    try {
      values[field.label] = field.decode(result.returnData, field.label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
