/*
 * Window geometry across launches. Zero-config polish: no setting, no UI, and
 * nothing written to any note — Sandy just opens where you left it instead of
 * re-centring a 1150×820 rectangle every morning.
 *
 * Everything is stored in physical pixels, so a mixed-DPI setup needs no
 * scale-factor arithmetic. The size recorded is the *inner* size — the exact
 * pair of setSize(), which resizes the client area. An undecorated Windows
 * window counts its invisible resize border into outerSize, so saving that
 * back and restoring it through setSize grew the window by the border every
 * cycle. The saved rect is validated against the monitors that exist *now*
 * before it is used: a window last closed on a laptop's second display must
 * not reopen off the edge of the world when that display is gone.
 */
/* v2: rects written before the innerSize fix are outer sizes, inflated by the
 * invisible resize border. Restoring one of those would re-seed the ratchet a
 * final time, and no validation can tell it apart from an honest rect — so the
 * old key is simply abandoned, at the cost of one forgotten window position. */
const KEY = "sandy:window:v2";

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

function load(): Geometry | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Geometry>;
    const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
    if (!num(v.x) || !num(v.y) || !num(v.width) || !num(v.height)) return null;
    if (v.width! < 200 || v.height! < 150) return null;
    return {
      x: Math.round(v.x!),
      y: Math.round(v.y!),
      width: Math.round(v.width!),
      height: Math.round(v.height!),
      maximized: v.maximized === true,
    };
  } catch {
    return null;
  }
}

function store(g: Geometry): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // non-fatal; the window just won't remember where it was
  }
}

/** Does the saved rect still land on a screen that exists? */
function onSomeMonitor(
  g: Geometry,
  monitors: Array<{ position: { x: number; y: number }; size: { width: number; height: number } }>,
): boolean {
  // require a real overlap, not a one-pixel corner: enough of the window (and
  // of its title strip in particular) has to be grabbable with the mouse
  const MIN = 120;
  return monitors.some((m) => {
    const overlapX =
      Math.min(g.x + g.width, m.position.x + m.size.width) - Math.max(g.x, m.position.x);
    const overlapY =
      Math.min(g.y + g.height, m.position.y + m.size.height) - Math.max(g.y, m.position.y);
    return overlapX >= MIN && overlapY >= MIN && g.y >= m.position.y - 8;
  });
}

/**
 * Apply the remembered geometry. Called while the window is still invisible, so
 * the move never shows as a jump. Any failure leaves the configured default.
 */
export async function restoreWindowGeometry(): Promise<void> {
  const saved = load();
  if (!saved) return;
  try {
    const { PhysicalPosition, PhysicalSize, availableMonitors, getCurrentWindow } = await import(
      "@tauri-apps/api/window"
    );
    const monitors = await availableMonitors();
    if (!onSomeMonitor(saved, monitors)) return;
    const win = getCurrentWindow();
    await win.setSize(new PhysicalSize(saved.width, saved.height));
    await win.setPosition(new PhysicalPosition(saved.x, saved.y));
    if (saved.maximized) await win.maximize();
  } catch {
    /* Deliberately silent, not an oversight: the window is still invisible and
     * the configured default is a perfectly good window. A notice here would
     * greet the launch with an apology for something nobody asked for. (A
     * release build has no console sink at all, so a warn went nowhere.) */
  }
}

/**
 * Record moves and resizes. Maximizing does not overwrite the stored rect — the
 * point of unmaximizing is to get the old window back.
 * Returns an unsubscribe function.
 */
export async function watchWindowGeometry(): Promise<() => void> {
  let timer = 0;
  const unlisten: Array<() => void> = [];
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();

    const record = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          try {
            const maximized = await win.isMaximized();
            if (maximized) {
              const previous = load();
              if (previous) store({ ...previous, maximized: true });
              return;
            }
            const position = await win.outerPosition();
            const size = await win.innerSize();
            store({
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height,
              maximized: false,
            });
          } catch {
            // a geometry read can fail mid-teardown; nothing to recover
          }
        })();
      }, 400);
    };

    unlisten.push(await win.onMoved(record));
    unlisten.push(await win.onResized(record));
  } catch {
    /* Same: the listeners not attaching costs the *next* launch its remembered
     * rect and nothing else. The returned unsubscribe stays valid either way. */
  }
  return () => {
    window.clearTimeout(timer);
    for (const off of unlisten) off();
  };
}
