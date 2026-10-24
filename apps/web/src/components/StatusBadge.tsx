/**
 * Colored pill showing a deployment's status (queued, building, uploading,
 * deployed, failed). In-progress states get a pulsing dot.
 */
import type { DeploymentStatus } from "@repo/shared";

const LABELS: Record<DeploymentStatus, string> = {
  queued: "Queued",
  building: "Building",
  uploading: "Uploading",
  deployed: "Ready",
  failed: "Error",
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const active = status === "queued" || status === "building" || status === "uploading";
  return (
    <span className={`badge badge-${status}`}>
      <span className={`dot${active ? " pulse" : ""}`} aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}
