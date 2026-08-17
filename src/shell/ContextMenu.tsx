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
 * window blur dismisses it. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

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
      // keep focus (and the editor selection) where it was
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
