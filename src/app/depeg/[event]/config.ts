// Compatibility entrypoint for script-lane consumers. Runtime ownership lives
// outside the route tree; scripts should migrate to src/lib/depeg-event-config.
export * from "@/lib/depeg-event-config";
