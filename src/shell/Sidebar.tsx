import { useEffect, useMemo, useRef, useState } from "react";
import {
  joinPath,
  noteStem,
  samePath,
  searchVault,
} from "../vault/vault";
import { loadExpandedDirs, saveExpandedDirs } from "../vault/session";

interface SidebarProps {
  /** Closed, the panel stays mounted and slides out (shell.css) — and inert. */
  open: boolean;
  root: string | null;
  files: string[];
  activePath: string | null;
  /** Frontmatter aliases of the open note — extra unlinked-mention terms. */
  activeAliases: string[];
  /** Known vaults (explicitly opened folders), most-recent-first. */
  vaults: string[];
  /** Rel path currently being renamed inline (context menu → Rename, or F2). */
  renameTarget: string | null;
  onOpenRel: (rel: string, line?: number) => void;
  onOpenFolder: () => void;
  onSwitchVault: (root: string) => void;
  onRemoveVault: (root: string) => void;
  onRenameRequest: (rel: string) => void;
  onRenameSubmit: (rel: string, newName: string) => void;
  onRenameCancel: () => void;
  onDeleteRel: (rel: string) => void;
}

const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/* One id space for both kinds of row, so the keyboard can walk the tree as the
 * flat list it looks like on screen. */
const dirId = (path: string) => `d:${path}`;
const fileId = (rel: string) => `f:${rel}`;

interface DirNode {
  name: string;
  path: string; // rel dir path, "" for root
  dirs: DirNode[];
  files: { rel: string; name: string }[];
}

function buildTree(files: string[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [] };
  const dirIndex = new Map<string, DirNode>([["", root]]);
  for (const rel of files) {
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let child = dirIndex.get(dirPath);
      if (!child) {
        child = { name: parts[i], path: dirPath, dirs: [], files: [] };
        dirIndex.set(dirPath, child);
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push({ rel, name: noteStem(rel) });
  }
  return root;
}

const CHEVRON = (open: boolean) => (
  <svg
    className={`tree-chevron${open ? " is-open" : ""}`}
    width="8"
    height="8"
    viewBox="0 0 8 8"
    aria-hidden="true"
  >
    <path d="M2 1 L6 4 L2 7" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

function TreeDir({
  node,
  depth,
  expanded,
  tabId,
  onToggle,
  renderFile,
}: {
  node: DirNode;
  depth: number;
  expanded: Set<string>;
  /** The one row in the tree that holds the tab stop (roving tabindex). */
  tabId: string | null;
  onToggle: (path: string) => void;
  renderFile: (file: { rel: string; name: string }, depth: number) => React.ReactNode;
}) {
  const open = expanded.has(node.path);
  return (
    <div>
      <button
        type="button"
        className="tree-row is-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        // the folder's identity on the row: what the context menu reads
        data-dir={node.path}
        data-row-id={dirId(node.path)}
        tabIndex={tabId === dirId(node.path) ? 0 : -1}
        aria-expanded={open}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        {CHEVRON(open)}
        <span>{node.name}</span>
      </button>
      {open ? (
        <div className="tree-children">
          {node.dirs.map((d) => (
            <TreeDir
              key={d.path}
              node={d}
              depth={depth + 1}
              expanded={expanded}
              tabId={tabId}
              onToggle={onToggle}
              renderFile={renderFile}
            />
          ))}
          {node.files.map((f) => renderFile(f, depth + 1))}
        </div>
      ) : null}
    </div>
  );
}

interface Mention {
  rel: string;
  line: number; // first mention — clicking jumps here
  count: number;
}

/* Backlinks: files whose text contains [[<stem>]] (alias/heading forms
 * included). Second section, Obsidian-style: unlinked mentions — files where
 * the stem or a frontmatter alias occurs as plain text outside any [[…]] span.
 * Both ride the same debounced scan; clicking a mention just navigates (the
 * one-click "Link" rewrite waits for the rename/link-rewrite session). */
function useBacklinks(
  root: string | null,
  files: string[],
  activePath: string | null,
  aliases: string[],
  /* The panel is mounted even while the sidebar is closed (it slides out
   * rather than unmounting), and this is a scan of every note in the vault —
   * it must not run for something nobody can see. */
  enabled: boolean,
) {
  const [links, setLinks] = useState<string[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  useEffect(() => {
    if (!root || !activePath || !enabled) {
      setLinks([]);
      setMentions([]);
      return;
    }
    const stem = noteStem(activePath);
    let stale = false;
    const timer = setTimeout(() => {
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const linkRe = new RegExp(`\\[\\[([^\\]]*/)?${esc(stem)}\\s*(\\]|\\||#)`, "i");
      // stem first (index 0 feeds backlinks), then aliases, case-folded unique
      const terms = [
        ...new Map([stem, ...aliases].map((t) => [t.toLowerCase(), t])).values(),
      ];
      Promise.all(terms.map((t) => searchVault(root, t)))
        .then((scans) => {
          if (stale) return;
          // one scan per term; the hit cap can cut each one short, which the
          // search panel says out loud and this panel simply lives with
          const results = scans.map((r) => r.hits);
          const linked = new Set<string>();
          for (const h of results[0]) {
            if (samePath(joinPath(root, h.rel), activePath)) continue;
            if (linkRe.test(h.text)) linked.add(h.rel);
          }
          const found = new Map<string, Mention>();
          const seen = new Set<string>();
          results.forEach((hits, i) => {
            // whole-word-ish: no letter/digit hugging either side of the term
            const mentionRe = new RegExp(
              `(?<![\\p{L}\\p{N}])${esc(terms[i])}(?![\\p{L}\\p{N}])`,
              "iu",
            );
            for (const h of hits) {
              if (samePath(joinPath(root, h.rel), activePath) || linked.has(h.rel)) continue;
              if (!mentionRe.test(h.text.replace(/\[\[[^\]]*\]\]/g, ""))) continue;
              const lineKey = `${h.rel}\u0000${h.line}`;
              if (seen.has(lineKey)) continue;
              seen.add(lineKey);
              const m = found.get(h.rel);
              if (m) m.count++;
              else found.set(h.rel, { rel: h.rel, line: h.line, count: 1 });
            }
          });
          setLinks([...linked]);
          setMentions([...found.values()].slice(0, 20));
        })
        .catch(() => {
          setLinks([]);
          setMentions([]);
        });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [root, files, activePath, aliases, enabled]);
  return { links, mentions };
}

/* Inline rename: the tree row itself becomes an input — no dialog. Enter
 * commits, Escape or clicking elsewhere cancels; an unchanged or empty name
 * is a cancel too (the Rust side is the validation authority).
 * A name with a "/" in it is also how a note is moved: "Projects/Ideas" puts
 * it in `Projects` under the vault root, making the folder if it isn't there.
 * The line under the field says where it is about to land, because "rename"
 * and "move" being the same field is only fair if you can see which one you
 * are doing. */
function RenameRow({
  name,
  padding,
  onSubmit,
  onCancel,
}: {
  name: string;
  padding: number;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(name);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = () => {
    const next = value.trim();
    if (!next || next === name) onCancel();
    else onSubmit(next);
  };
  const cut = value.lastIndexOf("/");
  const folder = cut > 0 ? value.slice(0, cut).replace(/^\/+/, "") : "";
  return (
    <>
      <div className="tree-row is-renaming" style={{ paddingLeft: padding }}>
        <input
          ref={inputRef}
          className="tree-rename-input"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
            e.stopPropagation();
          }}
          onBlur={onCancel}
        />
      </div>
      {folder ? (
        <div className="tree-rename-hint" style={{ paddingLeft: padding }}>
          Moves to {folder}/
        </div>
      ) : null}
    </>
  );
}

/* Vault switcher: the sidebar header opens a small menu of known vaults. */
function VaultSwitcher({
  root,
  vaults,
  onOpenFolder,
  onSwitchVault,
  onRemoveVault,
}: Pick<SidebarProps, "root" | "vaults" | "onOpenFolder" | "onSwitchVault" | "onRemoveVault">) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!root) return null;
  return (
    <div className="vault-switcher" ref={hostRef}>
      <button
        type="button"
        className="sidebar-head vault-head"
        title={root}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{folderName(root)}</span>
        <svg
          className={`tree-chevron vault-chevron${open ? " is-open" : ""}`}
          width="8"
          height="8"
          viewBox="0 0 8 8"
          aria-hidden="true"
        >
          <path d="M2 1 L6 4 L2 7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open ? (
        <div className="vault-menu">
          {vaults.map((v) => {
            const current = samePath(v, root);
            return (
              <div key={v} className={`vault-row${current ? " is-current" : ""}`}>
                <button
                  type="button"
                  className="vault-row-main"
                  title={v}
                  onClick={() => {
                    setOpen(false);
                    if (!current) onSwitchVault(v);
                  }}
                >
                  <span className="vault-row-name">{folderName(v)}</span>
                  <span className="vault-row-path">{v}</span>
                </button>
                <button
                  type="button"
                  className="vault-row-forget"
                  title="Forget this vault"
                  onClick={() => onRemoveVault(v)}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                    <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                </button>
              </div>
            );
          })}
          {vaults.length > 0 ? <div className="vault-menu-sep" /> : null}
          <button
            type="button"
            className="vault-row-main vault-open-folder"
            onClick={() => {
              setOpen(false);
              onOpenFolder();
            }}
          >
            <span className="vault-row-name">Open folder…</span>
            <span className="vault-row-path">Ctrl+Shift+O</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({
  open,
  root,
  files,
  activePath,
  activeAliases,
  vaults,
  renameTarget,
  onOpenRel,
  onOpenFolder,
  onSwitchVault,
  onRemoveVault,
  onRenameRequest,
  onRenameSubmit,
  onRenameCancel,
  onDeleteRel,
}: SidebarProps) {
  /* Folders start collapsed; the user's opened dirs persist per vault. */
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(root ? loadExpandedDirs(root) : []),
  );
  useEffect(() => {
    setExpanded(new Set(root ? loadExpandedDirs(root) : []));
  }, [root]);
  const tree = useMemo(() => buildTree(files), [files]);
  const { links: backlinks, mentions } = useBacklinks(
    root,
    files,
    activePath,
    activeAliases,
    open,
  );
  const treeRef = useRef<HTMLDivElement | null>(null);
  /** The row the keyboard last left the tab stop on (roving tabindex). */
  const [tabRow, setTabRow] = useState<string | null>(null);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
    if (root) saveExpandedDirs(root, [...next]);
  };

  const activeRel = useMemo(
    () =>
      root && activePath
        ? (files.find((f) => samePath(joinPath(root, f), activePath)) ?? null)
        : null,
    [root, activePath, files],
  );

  /* Open a note from anywhere but the tree — quick-open, a [[link]], Ctrl+N, a
   * move — and the tree used to keep showing the folder you were in, with the
   * note you are reading collapsed inside a closed one. Its folders unfold
   * once per note, so collapsing one by hand afterwards still sticks. */
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!root || !activeRel || revealedFor.current === activePath) return;
    revealedFor.current = activePath;
    const parts = activeRel.split("/").slice(0, -1);
    const missing = parts
      .map((_, i) => parts.slice(0, i + 1).join("/"))
      .filter((d) => !expanded.has(d));
    if (missing.length > 0) {
      const next = new Set([...expanded, ...missing]);
      setExpanded(next);
      saveExpandedDirs(root, [...next]);
    }
    // the row may be below the fold of a long tree; the unfold above renders first
    requestAnimationFrame(() =>
      treeRef.current
        ?.querySelector(`[data-row-id="${CSS.escape(fileId(activeRel))}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [root, activePath, activeRel, expanded]);

  /* Keyboard in the tree: one tab stop for the whole panel, arrows inside it.
   * A stop per row would put a 400-note vault between the sidebar and the
   * text. F2 and Delete are the two file commands the context menu already
   * has; folders keep neither, because those stay Explorer's (see App). */
  const focusRow = (el: HTMLElement | undefined) => {
    if (!el) return;
    setTabRow(el.dataset.rowId ?? null);
    el.focus();
  };
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = document.activeElement;
    // not on a row: the rename input is in here too, and owns its own keys
    if (!(el instanceof HTMLElement) || !el.dataset.rowId) return;
    const rows = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
    );
    const i = rows.indexOf(el);
    const dir = el.dataset.dir;
    const rel = el.dataset.rel;
    const step = (to: number) => {
      e.preventDefault();
      focusRow(rows[Math.max(0, Math.min(to, rows.length - 1))]);
    };
    if (e.key === "ArrowDown") step(i + 1);
    else if (e.key === "ArrowUp") step(i - 1);
    else if (e.key === "Home") step(0);
    else if (e.key === "End") step(rows.length - 1);
    else if (e.key === "ArrowRight") {
      if (dir != null && !expanded.has(dir)) {
        e.preventDefault();
        toggle(dir);
      } else step(i + 1);
    } else if (e.key === "ArrowLeft") {
      if (dir != null && expanded.has(dir)) {
        e.preventDefault();
        toggle(dir);
      } else step(i - 1);
    } else if (e.key === "F2" && rel) {
      e.preventDefault();
      onRenameRequest(rel);
    } else if (e.key === "Delete" && rel) {
      e.preventDefault();
      // the row is about to go; take the keyboard to its neighbour first
      focusRow(rows[i + 1] ?? rows[i - 1]);
      onDeleteRel(rel);
    }
  };

  const firstRow = tree.dirs[0]
    ? dirId(tree.dirs[0].path)
    : tree.files[0]
      ? fileId(tree.files[0].rel)
      : null;
  const tabId = tabRow ?? (activeRel ? fileId(activeRel) : firstRow);

  /* The stop can name a row that has since collapsed, been renamed or been
   * deleted — and then the tree has no tab stop at all. Hand it to the first
   * row whenever nothing is holding it. */
  useEffect(() => {
    const host = treeRef.current;
    if (!host || host.querySelector('[data-row-id][tabindex="0"]')) return;
    setTabRow(host.querySelector<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null);
  }, [tabId, files, expanded]);

  const renderFile = (f: { rel: string; name: string }, depth: number) => {
    const active = root != null && activePath != null && samePath(joinPath(root, f.rel), activePath);
    if (renameTarget === f.rel) {
      return (
        <RenameRow
          key={f.rel}
          name={f.name}
          padding={8 + depth * 14 + 13}
          onSubmit={(newName) => onRenameSubmit(f.rel, newName)}
          onCancel={onRenameCancel}
        />
      );
    }
    return (
      <button
        key={f.rel}
        type="button"
        className={`tree-row${active ? " is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 + 13 }}
        onClick={() => onOpenRel(f.rel)}
        title={f.rel}
        data-rel={f.rel}
        data-row-id={fileId(f.rel)}
        tabIndex={tabId === fileId(f.rel) ? 0 : -1}
      >
        <span>{f.name}</span>
      </button>
    );
  };

  return (
    <aside className={`sidebar${open ? "" : " is-closed"}`} inert={!open}>
      {root ? (
        <>
          <VaultSwitcher
            root={root}
            vaults={vaults}
            onOpenFolder={onOpenFolder}
            onSwitchVault={onSwitchVault}
            onRemoveVault={onRemoveVault}
          />
          <div className="sidebar-tree" ref={treeRef} onKeyDown={onTreeKeyDown}>
            {files.length === 0 ? (
              <div className="sidebar-empty">No notes here yet.</div>
            ) : (
              <>
                {tree.dirs.map((d) => (
                  <TreeDir
                    key={d.path}
                    node={d}
                    depth={0}
                    expanded={expanded}
                    tabId={tabId}
                    onToggle={toggle}
                    renderFile={renderFile}
                  />
                ))}
                {tree.files.map((f) => renderFile(f, 0))}
              </>
            )}
          </div>
          {backlinks.length > 0 ? (
            <div className="sidebar-backlinks">
              <div className="sidebar-head">Backlinks</div>
              {backlinks.map((rel) => (
                <button
                  key={rel}
                  type="button"
                  className="tree-row"
                  style={{ paddingLeft: 21 }}
                  onClick={() => onOpenRel(rel)}
                  title={rel}
                >
                  <span>{noteStem(rel)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {mentions.length > 0 ? (
            <div className="sidebar-backlinks">
              <div className="sidebar-head">Unlinked mentions</div>
              {mentions.map((m) => (
                <button
                  key={m.rel}
                  type="button"
                  className="tree-row"
                  style={{ paddingLeft: 21 }}
                  onClick={() => onOpenRel(m.rel, m.line)}
                  title={`${m.rel}:${m.line}`}
                >
                  <span>{noteStem(m.rel)}</span>
                  {m.count > 1 ? <span className="mention-count">{m.count}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="sidebar-empty">
          Open a folder to see your notes as a vault.
          <br />
          <button type="button" onClick={onOpenFolder}>
            Open folder… (Ctrl+Shift+O)
          </button>
        </div>
      )}
    </aside>
  );
}
