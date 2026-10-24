/**
 * Sidebar list of this browser's recent deployments (from localStorage).
 * Clicking one opens it in the detail view.
 */
import type { RecentDeployment } from "../lib/recent";
import { repoName, timeAgo } from "../lib/format";

interface Props {
  items: RecentDeployment[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function RecentList({ items, selectedId, onSelect }: Props) {
  return (
    <section className="card recent" aria-labelledby="recent-title">
      <h3 id="recent-title" className="section-title">
        Recent deployments
      </h3>
      {items.length === 0 ? (
        <p className="muted">Nothing yet. Deploy a repo to see it here.</p>
      ) : (
        <ul>
          {items.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className={`recent-item${d.id === selectedId ? " selected" : ""}`}
                onClick={() => onSelect(d.id)}
                aria-current={d.id === selectedId ? "true" : undefined}
              >
                <span className="recent-repo">{repoName(d.repoUrl)}</span>
                <span className="muted mono small">
                  {d.id} · {timeAgo(d.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
