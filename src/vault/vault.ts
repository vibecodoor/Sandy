/*
 * Vault kernel: folder scan, scan-search, wiki-link resolution. Framework-free.
 * The scan result is a disposable index — files on disk stay the only truth.
 * All rel paths use '/' separators (the Rust side normalizes).
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface SearchHit {
  rel: string;
  line: number;
  text: string;
}

export async function pickVaultFolder(): Promise<string | null> {
  const picked = await open({ directory: true });
  return typeof picked === "string" ? picked : null;
}

export async function scanVault(root: string): Promise<string[]> {
  return await invoke<string[]>("scan_vault", { root });
}

export interface SearchResult {
  hits: SearchHit[];
  /** The hit cap cut the walk short, alphabetically: notes later in the vault
   * were never looked at. Shown, so "no matches" can be trusted. */
  truncated: boolean;
}

export async function searchVault(root: string, query: string): Promise<SearchResult> {
  return await invoke<SearchResult>("search_vault", { root, query });
}

export interface NoteAliases {
  rel: string;
  aliases: string[];
}

/** Frontmatter aliases of every note (alias-less notes omitted). */
export async function scanAliases(root: string): Promise<NoteAliases[]> {
  return await invoke<NoteAliases[]>("scan_aliases", { root });
}

export async function createNote(path: string): Promise<void> {
  await invoke("create_note", { path });
}

export interface SkippedFile {
  rel: string;
  /** Why this note was left out, as a phrase to show after its name. */
  reason: string;
}

export interface RenameResult {
  new_rel: string;
  /** Rel paths whose [[links]] were rewritten and saved. */
  rewritten: string[];
  /** Rel paths where a needed rewrite was refused (external edit mid-op). */
  failed: string[];
  /** Notes the link rewrite could not even read. The rename is already done
   * when the walk starts, so the report has to be honest about them. */
  skipped: SkippedFile[];
  /** How many notes the rewrite looked at. */
  scanned: number;
  /** Why the rename isn't in git history, when it isn't. */
  git_error: string | null;
}

/** Rename a note (extension kept) and rewrite every link to it across the
 * vault — `[[wiki]]` and `[text](note.md)` alike, and only the ones that
 * actually resolved to it. A `newName` containing `/` is a path from the vault
 * root, i.e. a move; without one the note stays in its folder. The Rust side
 * validates every segment. */
export async function renameNote(
  root: string,
  oldRel: string,
  newName: string,
): Promise<RenameResult> {
  return await invoke<RenameResult>("rename_note", { root, oldRel, newName });
}

export interface DeleteResult {
  /** Attachments that went to the trash with the note (vault-rel paths):
   * inside its own `attachments/` folder, used by it, used by nothing else. */
  trashed: string[];
  /** Why the attachment sweep's answer is incomplete, when it is — a
   * stand-down (unreadable note, capped scan) or attachments that refused to
   * move. Null when `trashed` is the whole truth. */
  sweep_skipped: string | null;
  /** Why the deletion isn't in version history, when it isn't. */
  git_error: string | null;
}

/** Move a note to the system trash (recoverable — never a permanent delete),
 * with the attachments only it was using. Rejecting means the note is still
 * there. */
export async function deleteNote(path: string): Promise<DeleteResult> {
  return await invoke<DeleteResult>("delete_note", { path });
}

/* ── paths ────────────────────────────────────────────────── */

export function parentDir(path: string): string | null {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : null;
}

export function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

function normPath(p: string): string {
  return p.replaceAll("\\", "/").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/** Is `path` inside the folder `root` (case-insensitive, any separators)? */
export function isUnder(path: string, root: string): boolean {
  return normPath(path).startsWith(`${normPath(root).replace(/\/+$/, "")}/`);
}

const NOTE_EXT_RE = /\.(md|markdown|txt)$/i;

/** "sub/My Note.md" → "My Note" */
export function noteStem(relOrPath: string): string {
  const base = relOrPath.split(/[\\/]/).pop() ?? relOrPath;
  return base.replace(NOTE_EXT_RE, "");
}

/* ── attachments ──────────────────────────────────────────── */

/**
 * Rel path (note-relative) for a new image attachment:
 * "attachments/<sanitized-stem>-<yyyymmdd-hhmmssmmm>.<ext>".
 * Only markdown-URL-safe characters survive — no spaces or parentheses,
 * so the inserted `![](…)` never needs percent-encoding.
 */
export function attachmentRelPath(noteName: string, ext: string, now = new Date()): string {
  const stem =
    noteStem(noteName)
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "") || "image";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(now.getMilliseconds(), 3)}`;
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "png";
  return `attachments/${stem}-${ts}.${safeExt}`;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** Extension of a droppable image file, or null when it isn't one. */
export function imageExt(path: string): string | null {
  const m = IMAGE_EXT_RE.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/* ── wiki-links ───────────────────────────────────────────── */

/** Inner text of [[...]] → bare target name (alias and heading stripped). */
export function wikiTargetName(inner: string): string {
  return inner.split("|")[0].split("#")[0].trim();
}

/** Inner text of [[Note#Heading|alias]] → "Heading", or null when there is none. */
export function wikiTargetHeading(inner: string): string | null {
  const beforeAlias = inner.split("|")[0];
  const hash = beforeAlias.indexOf("#");
  if (hash < 0) return null;
  const heading = beforeAlias.slice(hash + 1).trim();
  return heading || null;
}

/**
 * Fold a heading (or a heading reference) to one comparison key, so
 * `[[Note#Ship It!]]`, `[[Note#ship-it]]` and `## Ship it!` all match.
 * NFKD first so accented letters compare by their base form.
 */
export function headingSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a wiki target against the vault index, case-insensitively
 * (Windows FS invariant). Returns the rel path of the matched note.
 * Match order: exact rel path → unique-ish stem anywhere → path suffix.
 *
 * Mirrored by `WikiIndex` in src-tauri/src/lib.rs, which is what a rename asks
 * before rewriting a link — so a bare `[[index]]` is only touched when it
 * really pointed at the renamed note. The two must not drift: change the match
 * order here and the writer starts rewriting the wrong links. Change both.
 */
export function resolveWikiTarget(target: string, files: string[]): string | null {
  const t = normPath(wikiTargetName(target));
  if (!t) return null;
  for (const f of files) {
    const fl = normPath(f);
    if (fl === t || fl.replace(NOTE_EXT_RE, "") === t) return f;
  }
  for (const f of files) {
    if (normPath(noteStem(f)) === t) return f;
  }
  for (const f of files) {
    if (normPath(f).replace(NOTE_EXT_RE, "").endsWith(`/${t}`)) return f;
  }
  return null;
}

/* Windows-reserved device names — creating files with these baseneames breaks. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turn a wiki target into a safe rel path for a new note ("a/b" → "a/b.md").
 * Sanitizes forbidden characters and reserved device names per segment.
 * Returns null when nothing usable remains.
 */
export function safeNoteRelPath(target: string): string | null {
  const name = wikiTargetName(target).replaceAll("\\", "/");
  if (!name) return null;
  const segments: string[] = [];
  for (const raw of name.split("/")) {
    let seg = raw
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/, "")
      .trim();
    if (!seg) continue;
    if (RESERVED.test(seg.replace(NOTE_EXT_RE, ""))) seg = `_${seg}`;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  const last = segments.length - 1;
  if (!NOTE_EXT_RE.test(segments[last])) segments[last] += ".md";
  return segments.join("/");
}
