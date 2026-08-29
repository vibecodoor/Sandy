import { useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | "sep"
  | {
      label: string;
      shortcut?: string;
      disabled?: boolean;
      action: () => void;
    };

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}

/* Project-styled replacement for the WebView2 context menu. Rendered at the
 * pointer, clamped to the viewport; any outside press, Escape, resize, or
 * window blur dismisses it. Keyboard-operable (s51 #30): `contextmenu` also
 * fires for Shift+F10 and the Menu key, so the first enabled item takes focus
 * on mount (restored on close — the CM6 selection lives in editor state and
 * survives the trip), arrows rove with wrap, Home/End jump, Tab closes. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current
      ?.querySelector<HTMLButtonElement>(".ctx-item:not([disabled])")
      ?.focus();
    return () => {
      const back = restoreRef.current;
      // an action that placed focus itself (the rename row) mounts after this
      // cleanup and wins; a plain dismiss lands back where the menu found it
      if (back?.isConnected) back.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const enabled = [
      ...(panelRef.current?.querySelectorAll<HTMLButtonElement>(".ctx-item:not([disabled])") ??
        []),
    ];
    if (!enabled.length) return;
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      enabled[(at + 1) % enabled.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      enabled[(at - 1 + enabled.length) % enabled.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      enabled[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      enabled[enabled.length - 1].focus();
    } else if (e.key === "Tab") {
      // the menu pattern: Tab dismisses rather than walking out behind it
      e.preventDefault();
      onClose();
    }
  };

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    });
  }, [x, y]);

  useLayoutEffect(() => {
    const away = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onKeyDown={onKeyDown}
      // a press inside the menu must not drag focus off the roving item
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className="ctx-item"
            tabIndex={-1}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            <span className="ctx-label">{item.label}</span>
            {item.shortcut ? <span className="ctx-shortcut">{item.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}
