/**
 * Type declarations for the VITE_* environment variables the frontend reads
 * through import.meta.env (values come from apps/web/.env at build time).
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
