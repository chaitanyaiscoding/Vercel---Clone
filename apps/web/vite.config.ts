/**
 * Vite config for the web frontend: React plugin, and the dev/preview server on
 * port 3000 — the origin the upload-service allows through CORS.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, strictPort: true },
  preview: { port: 3000, strictPort: true },
});
