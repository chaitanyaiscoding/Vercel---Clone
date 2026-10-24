/**
 * Small built-in HTML pages the request-handler shows instead of a user's site:
 * deployment not found, still building (auto-refreshes), failed, and generic errors.
 */
import type { DeploymentStatus } from "@repo/shared";

function page(title: string, body: string, refreshSeconds?: number) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
  <title>${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
           font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; }
    main { text-align: center; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    p { color: #a1a1a1; margin: 0; }
  </style>
</head>
<body><main><h1>${title}</h1><p>${body}</p></main></body>
</html>`;
}

export const notFoundPage = () =>
  page("404: Deployment not found", "This deployment doesn't exist or has been removed.");

export const fileNotFoundPage = () => page("404: Not found", "This file doesn't exist in the deployment.");

export const failedPage = () =>
  page("Deployment failed", "The build for this deployment failed, so there's nothing to show.");

export const inProgressPage = (status: DeploymentStatus) =>
  page("Deployment in progress", `Current status: ${status}. This page refreshes automatically.`, 5);

export const badRequestPage = () => page("400: Bad request", "That URL isn't valid.");

export const errorPage = () => page("Something went wrong", "Please try again in a moment.");
