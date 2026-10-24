/**
 * The "paste a GitHub URL and deploy" form.
 * Validates the URL in the browser with the SAME zod schema the server uses
 * (from @repo/shared), calls POST /deploy, and reports the new deployment id.
 */
import { useState, type FormEvent } from "react";
import { deployRequestSchema } from "@repo/shared";
import { createDeployment } from "../api";

const EXAMPLE = "https://github.com/RoyRao2333/template-vite-react-ts-tailwind";

interface Props {
  onCreated: (id: string, repoUrl: string) => void;
}

export function DeployForm({ onCreated }: Props) {
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = deployRequestSchema.safeParse({ repoUrl });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid URL");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { id } = await createDeployment(parsed.data.repoUrl);
      onCreated(id, parsed.data.repoUrl);
      setRepoUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card deploy-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor="repo-url" className="label">
        Import a public GitHub repository
      </label>
      <div className="input-row">
        <input
          id="repo-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
          onChange={(e) => {
            setRepoUrl(e.target.value);
            setError(null); // the old message no longer describes what's typed
          }}
          aria-invalid={error !== null}
          aria-describedby={error ? "repo-url-error" : "repo-url-hint"}
          disabled={submitting}
        />
        <button type="submit" className="button primary" disabled={submitting || repoUrl.trim() === ""}>
          {submitting ? "Deploying…" : "Deploy"}
        </button>
      </div>
      {error ? (
        <p id="repo-url-error" className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id="repo-url-hint" className="hint">
          Static frontends only (Vite, CRA…). Try{" "}
          <button type="button" className="link-button" onClick={() => setRepoUrl(EXAMPLE)}>
            an example repo
          </button>
          .
        </p>
      )}
    </form>
  );
}
