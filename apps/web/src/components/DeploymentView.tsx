/**
 * Detail view for one deployment: repo + commit, status badge, a progress
 * stepper (queued → building → uploading → ready), the live site link once
 * deployed, the error once failed, and the live build logs.
 */
import type { DeploymentStatus } from "@repo/shared";
import { useDeployment } from "../hooks/useDeployment";
import { duration, repoName, shortSha } from "../lib/format";
import { LogViewer } from "./LogViewer";
import { StatusBadge } from "./StatusBadge";

const STEPS: { status: DeploymentStatus; label: string }[] = [
  { status: "queued", label: "Queued" },
  { status: "building", label: "Building" },
  { status: "uploading", label: "Uploading" },
  { status: "deployed", label: "Ready" },
];

function Steps({ status }: { status: DeploymentStatus }) {
  // A failed deployment can fail during building or uploading; we only know it
  // failed, so mark everything up to "uploading" as reached and the end as failed.
  const current = status === "failed" ? STEPS.length - 1 : STEPS.findIndex((s) => s.status === status);

  return (
    <ol className="steps" aria-label="Deployment progress">
      {STEPS.map((step, i) => {
        const state =
          status === "failed" && i === current ? "failed" : i < current || status === "deployed" ? "done" : i === current ? "current" : "todo";
        return (
          <li key={step.status} className={`step step-${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="step-dot" aria-hidden="true" />
            {status === "failed" && i === current ? "Failed" : step.label}
          </li>
        );
      })}
    </ol>
  );
}

export function DeploymentView({ id }: { id: string }) {
  const { deployment, logs, error } = useDeployment(id);

  if (!deployment) {
    return (
      <section className="card">
        {error ? <p className="form-error">{error}</p> : <p className="muted">Loading deployment {id}…</p>}
      </section>
    );
  }

  const finished = deployment.status === "deployed" || deployment.status === "failed";
  const commitUrl = `${deployment.repoUrl}/commit/${deployment.sha}`;

  return (
    <section className="card deployment" aria-labelledby="deployment-title">
      <header className="deployment-header">
        <div className="deployment-title">
          <h2 id="deployment-title">{repoName(deployment.repoUrl)}</h2>
          <p className="muted mono">
            {deployment.id} ·{" "}
            <a href={commitUrl} target="_blank" rel="noreferrer">
              {shortSha(deployment.sha)}
            </a>{" "}
            · {duration(deployment.createdAt, finished ? deployment.updatedAt : undefined)}
          </p>
        </div>
        <StatusBadge status={deployment.status} />
      </header>

      <Steps status={deployment.status} />

      {deployment.status === "deployed" && (
        <div className="callout callout-ok">
          <span>Your site is live</span>
          <a className="button primary" href={deployment.url} target="_blank" rel="noreferrer">
            Visit {deployment.url.replace(/^https?:\/\//, "")} ↗
          </a>
        </div>
      )}
      {deployment.status === "failed" && (
        <div className="callout callout-error" role="alert">
          {deployment.error ?? "The deployment failed."}
        </div>
      )}
      {error && <p className="form-error">Connection problem: {error} (retrying…)</p>}

      <h3 className="section-title">Build logs</h3>
      <LogViewer lines={logs} waiting={!finished} />
    </section>
  );
}
