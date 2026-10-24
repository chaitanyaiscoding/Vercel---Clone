/**
 * React hook that follows one deployment live.
 * Polls GET /status/:id and then GET /status/:id/logs?from=<next> every 2 s,
 * appending only new log lines, and stops once the deployment is deployed or
 * failed (or doesn't exist). Switching `id` resets everything.
 */
import { useEffect, useState } from "react";
import type { DeploymentResponse } from "@repo/shared";
import { ApiError, getDeployment, getLogs } from "../api";

const POLL_MS = 2000;
const MAX_LINES_IN_MEMORY = 2000;

export function useDeployment(id: string | null) {
  const [deployment, setDeployment] = useState<DeploymentResponse | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let from = 0; // absolute line number of the next log line we need

    setDeployment(null);
    setLogs([]);
    setError(null);

    async function tick(deploymentId: string) {
      try {
        // Status FIRST, then logs: the worker flushes all logs before writing the
        // final status, so if we see "deployed" here, the logs request below
        // is guaranteed to include the last lines.
        const d = await getDeployment(deploymentId);
        const l = await getLogs(deploymentId, from);
        if (cancelled) return;

        setDeployment(d);
        setError(null);
        if (l.lines.length > 0) setLogs((prev) => [...prev, ...l.lines].slice(-MAX_LINES_IN_MEMORY));
        from = l.next;

        if (d.status === "deployed" || d.status === "failed") return; // done, stop polling
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Something went wrong");
        if (err instanceof ApiError && err.status === 404) return; // won't appear later
      }
      timer = setTimeout(() => void tick(deploymentId), POLL_MS);
    }

    void tick(id);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  return { deployment, logs, error };
}
