/**
 * "Recent deployments" kept in this browser's localStorage (there are no user
 * accounts yet). Every access is wrapped in try/catch: storage can be disabled
 * or full (private windows, blocked site data), and the app must still work.
 */
export interface RecentDeployment {
  id: string;
  repoUrl: string;
  createdAt: string; // ISO
}

const KEY = "vercel-clone:recent-deployments";
const MAX = 10;

export function loadRecent(): RecentDeployment[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as RecentDeployment[]) : [];
  } catch {
    return [];
  }
}

export function saveRecent(entry: RecentDeployment): RecentDeployment[] {
  const next = [entry, ...loadRecent().filter((d) => d.id !== entry.id)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: keep the in-memory list for this session only
  }
  return next;
}
