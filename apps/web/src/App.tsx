/**
 * Root component: page layout, the deploy form, the selected deployment, and
 * the recent-deployments list. The selected deployment lives in the URL
 * (?d=<id>), so a deployment page can be bookmarked, shared and refreshed,
 * and the browser back button works.
 */
import { useEffect, useState } from "react";
import { DEPLOYMENT_ID_REGEX } from "@repo/shared";
import { DeployForm } from "./components/DeployForm";
import { DeploymentView } from "./components/DeploymentView";
import { RecentList } from "./components/RecentList";
import { loadRecent, saveRecent, type RecentDeployment } from "./lib/recent";

function idFromUrl() {
  const id = new URLSearchParams(window.location.search).get("d");
  return id && DEPLOYMENT_ID_REGEX.test(id) ? id : null;
}

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(idFromUrl);
  const [recent, setRecent] = useState<RecentDeployment[]>(loadRecent);

  useEffect(() => {
    const onPopState = () => setSelectedId(idFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function select(id: string) {
    if (id === selectedId) return;
    window.history.pushState(null, "", `?d=${id}`);
    setSelectedId(id);
  }

  function handleCreated(id: string, repoUrl: string) {
    setRecent(saveRecent({ id, repoUrl, createdAt: new Date().toISOString() }));
    select(id);
  }

  return (
    <div className="page">
      <header className="topbar">
        <a href="/" className="brand" aria-label="vercel-clone home">
          <img src="/favicon.svg" alt="" width="24" height="24" />
          vercel-clone
        </a>
      </header>

      <main className="layout">
        <div className="main-column">
          <div className="hero">
            <h1>Deploy a frontend in one click</h1>
            <p className="muted">Paste a public GitHub repo. We build it in an isolated container and host it.</p>
          </div>
          <DeployForm onCreated={handleCreated} />
          {selectedId && <DeploymentView key={selectedId} id={selectedId} />}
        </div>
        <aside className="side-column">
          <RecentList items={recent} selectedId={selectedId} onSelect={select} />
        </aside>
      </main>
    </div>
  );
}
