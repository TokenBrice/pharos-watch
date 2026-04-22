import { Suspense } from "react";
import FlowsClient from "./client";

export default function FlowsPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse" />
      </div>
    }>
      <FlowsClient />
    </Suspense>
  );
}
