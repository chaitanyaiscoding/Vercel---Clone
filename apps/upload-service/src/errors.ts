import type { ErrorRequestHandler } from "express";

// Throw this anywhere in a handler; its message is safe to show the client.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  // express.json() errors (malformed JSON, body too large) carry a client-safe status
  if (typeof err?.status === "number" && err.status < 500 && err.expose) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  // Unknown error: log the details, never leak them to the client
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
