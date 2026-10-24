/**
 * Terminal-style build log panel.
 * Auto-scrolls to the newest line while the user is at the bottom, but stops
 * auto-scrolling if they scroll up to read something.
 */
import { useEffect, useRef } from "react";

interface Props {
  lines: string[];
  waiting: boolean; // deployment still running → show a "waiting for logs" hint
}

export function LogViewer({ lines, waiting }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return (
    <div className="logs" ref={ref} onScroll={handleScroll} role="log" aria-live="polite" tabIndex={0}>
      {lines.length === 0 ? (
        <p className="logs-empty">{waiting ? "Waiting for build logs…" : "No logs."}</p>
      ) : (
        <ol>
          {lines.map((line, i) => (
            <li key={i}>
              <span className="ln" aria-hidden="true">
                {i + 1}
              </span>
              <span className={line.startsWith("✗") ? "log-error" : line.startsWith("✓") ? "log-ok" : undefined}>
                {line}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
