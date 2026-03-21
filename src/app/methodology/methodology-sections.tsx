import { CoreMethodologySections } from "./sections/core-sections";
import { MonitoringMethodologySections } from "./sections/monitoring-sections";

export function MethodologySections() {
  return (
    <>
      <CoreMethodologySections />
      <MonitoringMethodologySections />
    </>
  );
}
