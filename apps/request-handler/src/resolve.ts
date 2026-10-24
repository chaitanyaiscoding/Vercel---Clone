/**
 * Maps a URL path to the S3 keys (relative to the deployment's folder) to try, in order.
 *   /                 → index.html
 *   /docs/            → docs/index.html
 *   /assets/app.js    → assets/app.js                     (has an extension: exact file only)
 *   /about            → about, about.html, about/index.html, then index.html (SPA fallback)
 * The SPA fallback lets client-side routers (React Router etc.) handle deep links.
 * Paths that try to escape the deployment folder are rejected.
 */

export interface Resolution {
  keys: string[]; // try these in order, first hit wins
  spaFallback: boolean; // if none exist, serve index.html instead of a 404
}

// Returns null for malformed or malicious paths (→ 400).
export function resolvePath(urlPath: string): Resolution | null {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return null; // bad percent-encoding like "%E0%A4%A"
  }

  // S3 keys are plain strings, so ".." can't really escape the prefix, but
  // reject it anyway (and NUL / backslashes) rather than rely on that.
  if (path.includes("\0") || path.includes("\\") || path.split("/").includes("..")) return null;

  const rel = path.replace(/^\/+/, "");

  if (rel === "" || rel.endsWith("/")) return { keys: [rel + "index.html"], spaFallback: false };

  const lastSegment = rel.slice(rel.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return { keys: [rel], spaFallback: false };

  return { keys: [rel, `${rel}.html`, `${rel}/index.html`], spaFallback: true };
}
