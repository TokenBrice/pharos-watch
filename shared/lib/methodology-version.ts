// Compatibility shim for historical `@shared/lib/methodology-version`
// imports. New methodology modules should import from
// `@shared/lib/methodology-versions/base`, but this path remains public for
// worker/frontend/runtime callers.
export * from "./methodology-versions/base";
