/**
 * Worker-side facade. The depeg-signal primitives are runtime-neutral and live
 * in `shared/lib/depeg-signals.ts` so that shared consumers (Chain Health) and
 * Worker consumers derive deviation from one implementation.
 */
export * from "@shared/lib/depeg-signals";
