/*
 * Vault kernel: file I/O. Framework-free.
 * Data-path rules:
 *  - the editor doc IS the file text; no transforms besides EOL bookkeeping below
 *  - CM6 stores lines LF-joined, so we detect the file's EOL on load and restore
 *    it on save. Consistent CRLF or LF round-trips byte-for-byte. Mixed-EOL files
 *    are normalized to their dominant style for now — flagged via `mixedEol` so
 *    the app can say it out loud, and covered later by the round-trip corpus
 *    (per-line EOL map if it matters).
 */
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type Eol = "\n" | "\r\n";

export interface LoadedDoc {
  text: string; // LF-normalized for the editor
  eol: Eol;
  /** The file mixed CRLF and LF, so saving rewrites its minority line endings
   * to the dominant style. The one place Sandy does normalize — say it once. */
  mixedEol?: boolean;
}

/** Tauri rejects with the string the native side returned. Wrap it so callers
 * can rely on `.message` — and so what they show is the sentence Rust wrote,
 * which is written to be shown as it is. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Foreign formats the Rust importer converts to Markdown (mirrors convert.rs). */
export const IMPORT_EXTS = [
  "docx",
  "html",
  "htm",
  "csv",
  "xlsx",
  "xls",
  "json",
  "xml",
  "pptx",
  "pdf",
];

export function isImportable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMPORT_EXTS.includes(path.slice(dot + 1).toLowerCase());
}

/** Convert a foreign file (DOCX/XLSX/PDF/…) to Markdown text (read-only on the
 * source; the caller writes the result through the normal atomic save path). */
export async function convertToMarkdown(path: string): Promise<string> {
  return await invoke<string>("convert_file_to_markdown", { path });
}
export async function fileExists(path: string): Promise<boolean> {
  return await invoke<boolean>("file_exists", { path });
}


export async function pickMarkdownFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [
      { name: "Notes & documents", extensions: ["md", "markdown", "txt", ...IMPORT_EXTS] },
      { name: "Markdown", extensions: ["md", "markdown", "txt"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** Ask where to write an exported PDF; defaults to the note's name. */
export async function pickPdfSavePath(noteName?: string): Promise<string | null> {
  const base = (noteName ?? "note").replace(/\.(md|markdown|txt)$/i, "");
  const picked = await save({
    defaultPath: `${base}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof picked !== "string") return null;
  // The dialog only filters to .pdf — a typed "todo.md" comes back as typed,
  // and the export would write straight over that note. The native side forces
  // the same suffix; this keeps the path the app shows in step with it.
  return /\.pdf$/i.test(picked) ? picked : `${picked}.pdf`;
}

/* UTF-8 BOM: a byte-order mark read as text becomes a U+FEFF at position 0,
 * which is invisible but real — it makes the first line stop parsing as a
 * heading, and it sits in front of the caret on Ctrl+Home. It is stripped for
 * the editor and put back on save, so a BOM'd file still round-trips
 * byte-for-byte. Kept in a per-path map rather than on LoadedDoc: it is a
 * property of the file, not of the text, and this is the boundary that owns it
 * (same shape as the native writer's fingerprint map). */
// spelled out, not typed: a literal U+FEFF in source is invisible to review
const BOM = String.fromCharCode(0xfeff);
const bomPaths = new Set<string>();

function pathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

export async function loadDoc(path: string): Promise<LoadedDoc> {
  let raw: string;
  try {
    raw = await invoke<string>("read_doc", { path });
  } catch (err) {
    // the native side names which kind of unreadable this is (gone / refused /
    // not UTF-8, with the encoding it looks like) — keep that sentence whole
    throw asError(err);
  }
  const key = pathKey(path);
  if (raw.startsWith(BOM)) {
    bomPaths.add(key);
    raw = raw.slice(BOM.length);
  } else {
    bomPaths.delete(key);
  }
  const crlfCount = (raw.match(/\r\n/g) ?? []).length;
  const bareLfCount = (raw.match(/(?<!\r)\n/g) ?? []).length;
  const eol: Eol = crlfCount > bareLfCount ? "\r\n" : "\n";
  return {
    text: raw.replaceAll("\r\n", "\n"),
    eol,
    // Both styles present: one `eol` goes back on every line at save time, so
    // the minority endings change. Reported, not silently absorbed.
    mixedEol: crlfCount > 0 && bareLfCount > 0,
  };
}

/**
 * Forget any BOM remembered for this path. For the one write that precedes its
 * own `loadDoc` — an import creating the note (App.tsx) — where the flag would
 * otherwise be a *previous* file's, read at the same path before it was deleted:
 * the converter never produced a BOM, `loadDoc` strips the one we prepended, and
 * it stays in the file for its whole life, visible only in git and other tools.
 * Never key this off `saveDoc`'s `force` flag — the conflict banner's "keep what
 * I wrote" forces too, and there the BOM must survive.
 */
export function forgetBom(path: string): void {
  bomPaths.delete(pathKey(path));
}

/** Marker the native writer puts on a refused save (mirrors lib.rs::DISK_CONFLICT). */
export const DISK_CONFLICT = "sandy:disk-conflict";

/** Did this save fail because the file changed underneath us? Never retryable. */
export function isDiskConflict(message: string): boolean {
  return message.includes(DISK_CONFLICT);
}

export interface SaveResult {
  /** Why git didn't record this save, if it didn't. The write itself
   * succeeded — a save is never failed by its history. */
  gitError?: string;
}

/**
 * `force` skips the native disk-authority guard. Only ever set from an explicit
 * user choice to overwrite someone else's version — never from an automatic retry.
 * Throws only when the bytes did not reach disk.
 */
export async function saveDoc(
  path: string,
  editorText: string,
  eol: Eol,
  force = false,
): Promise<SaveResult> {
  // the whole of the EOL restore: one line ending back on every line
  const body = eol === "\r\n" ? editorText.replaceAll("\n", "\r\n") : editorText;
  const contents = bomPaths.has(pathKey(path)) ? BOM + body : body;
  await invoke("save_doc", { path, contents, force });
  const gitError = await gitAutocommit(path);
  return gitError ? { gitError } : {};
}

/* Attachments: binary writes stay native-side (atomic, quarantined data path).
 * The frontend only hands over bytes / a source path — never file contents. */
export async function saveAttachment(path: string, data: ArrayBuffer): Promise<void> {
  await invoke("save_attachment", { path, bytes: Array.from(new Uint8Array(data)) });
}

export async function copyAttachment(src: string, dest: string): Promise<void> {
  await invoke("copy_attachment", { src, dest });
}

/* History is a safety net: it never blocks the editor and never throws. The
 * reason travels back as a one-line sentence instead of into a console no
 * release build has a sink for. */
export async function gitAutocommit(path: string): Promise<string | undefined> {
  try {
    await invoke("git_autocommit", { path });
    return undefined;
  } catch (err) {
    return asError(err).message;
  }
}

export async function initialFile(): Promise<string | null> {
  return await invoke<string | null>("initial_file");
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(i + 1) : path;
}
