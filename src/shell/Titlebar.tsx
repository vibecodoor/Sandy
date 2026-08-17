import { useEffect, useState } from "react";
import { isTauri } from "../vault/files";

interface TitlebarProps {
  title: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

/* Undecorated-window titlebar: the strip itself is the drag region
 * (double-click = maximize, handled natively via the drag region). */
export function Titlebar({
  title,
  sidebarOpen,
  onToggleSidebar,
  theme,
  onToggleTheme,
}: TitlebarProps) {
  const [maximized, setMaximized] = useState(false);
  /* The one place the app can say what it is. There is no telemetry and no
   * About dialog to build, and a bug report is worthless without a version —
   * so it rides the titlebar's own tooltip, where it costs nothing to carry. */
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let dropped = false;
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => {
        if (!dropped) setVersion(v);
      })
      .catch(() => undefined); // no version to show is not worth saying anything about
    return () => {
      dropped = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let dropped = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
      sync();
      const un = await win.onResized(sync);
      if (dropped) un();
      else off = un;
    });
    return () => {
      dropped = true;
      off?.();
    };
  }, []);

  const winAction = (action: "minimize" | "toggleMaximize" | "close") => {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()[action](),
    );
  };

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      title={version ? `Sandy ${version}` : undefined}
    >
      <button
        type="button"
        className="tb-btn"
        title={sidebarOpen ? "Hide sidebar (Ctrl+\\)" : "Show sidebar (Ctrl+\\)"}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1" y="2" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" />
          <line x1="5" y1="2" x2="5" y2="12" stroke="currentColor" />
        </svg>
      </button>

      {title ? <span className="titlebar-title">{title}</span> : null}

      <div className="titlebar-spacer" data-tauri-drag-region />

      <button
        type="button"
        className="tb-btn tb-theme"
        title={theme === "dark" ? "Light theme" : "Dark theme"}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="3" fill="none" stroke="currentColor" />
            <g stroke="currentColor">
              <line x1="7" y1="0.5" x2="7" y2="2" />
              <line x1="7" y1="12" x2="7" y2="13.5" />
              <line x1="0.5" y1="7" x2="2" y2="7" />
              <line x1="12" y1="7" x2="13.5" y2="7" />
              <line x1="2.4" y1="2.4" x2="3.5" y2="3.5" />
              <line x1="10.5" y1="10.5" x2="11.6" y2="11.6" />
              <line x1="2.4" y1="11.6" x2="3.5" y2="10.5" />
              <line x1="10.5" y1="3.5" x2="11.6" y2="2.4" />
            </g>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M11.5 8.5A5 5 0 0 1 5.5 2.5 5 5 0 1 0 11.5 8.5Z"
              fill="none"
              stroke="currentColor"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      {isTauri ? (
        <div className="titlebar-controls">
          <button
            type="button"
            className="tb-btn tb-win"
            title="Minimize"
            onClick={() => winAction("minimize")}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="tb-btn tb-win"
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => winAction("toggleMaximize")}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
                <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="tb-btn tb-win tb-close"
            title="Close"
            onClick={() => winAction("close")}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" />
            </svg>
          </button>
        </div>
      ) : null}
    </header>
  );
}
