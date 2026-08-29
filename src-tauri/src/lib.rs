use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

mod convert;
#[cfg(target_os = "windows")]
mod pdf;

/// Marker prefix on the one save error the UI must handle rather than retry:
/// the file changed underneath us, so writing would destroy someone else's work.
pub const DISK_CONFLICT: &str = "sandy:disk-conflict";

/// Fingerprint of the bytes Sandy itself last read from / wrote to each path.
/// This is the whole disk-authority guard: a save compares the file's current
/// bytes against this, and refuses when they diverge. Fail-open by design —
/// an unknown path is written normally, so imports and new notes are unaffected.
fn known_bytes() -> &'static Mutex<HashMap<PathBuf, u64>> {
    static KNOWN: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// FNV-1a 64. Not cryptographic — this only has to notice that bytes changed.
fn fingerprint(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn remember(path: &Path, bytes: &[u8]) {
    if let Ok(mut map) = known_bytes().lock() {
        map.insert(path.to_path_buf(), fingerprint(bytes));
    }
}

fn note_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// std's io errors already read as English on Windows; only the trailing
/// "(os error 32)" is machine talk. Every message here is shown to the user.
fn plain_os_error(e: &std::io::Error) -> String {
    let full = e.to_string();
    let head = full.split(" (os error").next().unwrap_or(&full);
    head.trim().trim_end_matches('.').to_string()
}

/// Why a note wouldn't open, in words someone can act on. A missing note, a
/// locked one and one that isn't text used to fail identically — as nothing.
/// No name and no verb in here: every surface of a read error already sits
/// behind an App sentence that says "Couldn't open “name”." — carrying both
/// again read as a stutter ("Couldn't open “x”. Sandy couldn't open x — …").
fn unreadable(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "It was moved or deleted.".to_string(),
        std::io::ErrorKind::PermissionDenied => "Windows refused permission.".to_string(),
        _ => format!("{}.", plain_os_error(e)),
    }
}

/// The same reasons as a phrase, for listing next to a note's name in a report.
fn why_skipped(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "gone from the folder".to_string(),
        std::io::ErrorKind::PermissionDenied => "Windows refused permission".to_string(),
        std::io::ErrorKind::InvalidData => "not UTF-8 text".to_string(),
        _ => plain_os_error(e),
    }
}

fn do_read_doc(path: &str) -> Result<String, String> {
    let p = PathBuf::from(path);
    let bytes = std::fs::read(&p).map_err(|e| unreadable(&e))?;
    // Naming beats decoding: a UTF-16 note opened as text would be re-encoded
    // whole on the first save, and the bytes are the product.
    let text = String::from_utf8(bytes).map_err(|e| {
        format!(
            "It isn't UTF-8 text — it looks like {}. Sandy leaves it as it is \
             rather than re-encoding the whole file.",
            convert::encoding_name(e.as_bytes())
        )
    })?;
    remember(&p, text.as_bytes());
    Ok(text)
}

/// Read a document as UTF-8 text, bytes untouched.
#[tauri::command]
async fn read_doc(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || do_read_doc(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Read-only existence check used to keep generated imports from overwriting edits.
#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Remove `.tmp*` siblings left behind by a save that was killed between
/// "create temp" and "rename over target". Only files older than the cutoff are
/// touched, so a concurrent writer's temp — always younger — is never at risk.
/// Rate-limited process-wide: a vault folder can hold thousands of entries and
/// this must not turn every keystroke-triggered save into a directory walk.
fn sweep_stale_temps(dir: &Path) {
    const MAX_AGE: Duration = Duration::from_secs(30);
    const EVERY: Duration = Duration::from_secs(60);

    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(None));
    match last.lock() {
        Ok(mut slot) => {
            if slot.is_some_and(|t| t.elapsed() < EVERY) {
                return;
            }
            *slot = Some(Instant::now());
        }
        Err(_) => return,
    }
    sweep_temps_older_than(dir, MAX_AGE);
}

fn sweep_temps_older_than(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // tempfile's NamedTempFile names are ".tmp" + 6 random characters.
        if !name.starts_with(".tmp") || name.len() != 10 {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| SystemTime::now().duration_since(m).unwrap_or_default() >= max_age)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path()); // best effort, never fatal
        }
    }
}

/// Atomic save: temp file in the same directory + fsync + rename over target.
/// This module is the data path — keep it small; never add content transforms here.
///
/// Two gates run before the write, in order:
///  1. no-op — identical bytes are not rewritten, so an unchanged document
///     never churns mtime or manufactures an empty git commit;
///  2. disk authority — if the file's current bytes are not the ones Sandy last
///     read or wrote, someone else edited it and the save is refused. Disk wins;
///     the caller surfaces the conflict rather than clobbering the other writer.
///
/// `force` skips gate 2 only. It exists for one caller: the user explicitly
/// choosing to overwrite the other version from the conflict banner.
fn do_save_doc(path: &str, contents: &str, force: bool) -> Result<(), String> {
    let target = PathBuf::from(path);
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("save {path}: no parent directory"))?;

    match std::fs::read(&target) {
        Ok(on_disk) => {
            if on_disk == contents.as_bytes() {
                remember(&target, &on_disk);
                return Ok(());
            }
            let expected = known_bytes().lock().ok().and_then(|m| m.get(&target).copied());
            if let Some(expected) = expected {
                if !force && fingerprint(&on_disk) != expected {
                    return Err(format!("{DISK_CONFLICT}: {path} changed on disk"));
                }
            }
        }
        // Gone, but we remember writing it: it was deleted or moved underneath
        // us. Writing would resurrect the note from a stale buffer without a
        // word, so this is a conflict like any other — disk wins.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let known = known_bytes().lock().is_ok_and(|m| m.contains_key(&target));
            if !force && known {
                return Err(format!("{DISK_CONFLICT}: {path} is no longer on disk"));
            }
        }
        // Unreadable for some other reason — a sharing violation from a sync
        // client, an antivirus scanner, another editor holding the file open.
        // Both gates just went blind, and the population that produces
        // transient locks is the same one that produces genuine external edits:
        // if the lock clears before the rename lands (milliseconds) we take the
        // other writer's edit with us. So a note we remember is a conflict,
        // exactly like the missing one above. A path we've never read still
        // fails open — imports and new notes are unaffected.
        Err(e) => {
            let known = known_bytes().lock().is_ok_and(|m| m.contains_key(&target));
            if !force && known {
                return Err(format!("{DISK_CONFLICT}: {path} — {}", plain_os_error(&e)));
            }
        }
    }

    sweep_stale_temps(dir);
    // every message below is shown as written — plain_os_error strips the
    // "(os error N)" machine talk the raw Display carries (s51 #33)
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("save {path}: temp: {}", plain_os_error(&e)))?;
    tmp.write_all(contents.as_bytes())
        .map_err(|e| format!("save {path}: write: {}", plain_os_error(&e)))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("save {path}: sync: {}", plain_os_error(&e)))?;
    tmp.persist(&target)
        .map_err(|e| format!("save {path}: rename: {}", plain_os_error(&e.error)))?;
    remember(&target, contents.as_bytes());
    Ok(())
}

#[tauri::command]
async fn save_doc(path: String, contents: String, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_save_doc(&path, &contents, force))
        .await
        .map_err(|e| e.to_string())?
}

/// Atomic binary write for image attachments. Same discipline as do_save_doc
/// (temp + fsync + rename); also creates the missing attachments/ directory.
fn do_save_attachment(path: &str, bytes: &[u8]) -> Result<(), String> {
    let target = PathBuf::from(path);
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "There's no folder to put it in.".to_string())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Couldn't make its folder — {}.", plain_os_error(&e)))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("{}.", plain_os_error(&e)))?;
    tmp.write_all(bytes)
        .map_err(|e| format!("{}.", plain_os_error(&e)))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("{}.", plain_os_error(&e)))?;
    tmp.persist(&target)
        .map_err(|e| format!("{}.", plain_os_error(&e.error)))?;
    Ok(())
}

/// Write a pasted image into the note's attachments folder.
#[tauri::command]
async fn save_attachment(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_save_attachment(&path, &bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// Copy a dropped image file into the note's attachments folder.
#[tauri::command]
async fn copy_attachment(src: String, dest: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&src).map_err(|e| format!("Couldn't read the dropped file — {}.", plain_os_error(&e)))?;
        do_save_attachment(&dest, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Commit one saved file into its enclosing git repo (init one next to the
/// file if none exists). History is the safety net — never blocks the save.
#[tauri::command]
async fn git_autocommit(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_git_autocommit(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn run_git(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output().map_err(|e| {
        // git is not on a default Windows box, and the whole history promise
        // rests on it — say so instead of logging a spawn error nobody sees.
        if e.kind() == std::io::ErrorKind::NotFound {
            "Sandy couldn't find git, so it can't keep a history of your notes.".to_string()
        } else {
            format!("git {}: {}", args.first().unwrap_or(&""), plain_os_error(&e))
        }
    })
}

/// The first thing git actually said, for showing verbatim.
fn git_said(out: &std::process::Output) -> String {
    let msg = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let line = msg.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
    if line.is_empty() { "git gave no reason".to_string() } else { line }
}

/// Real repo root per git itself (handles worktrees, stray/broken .git dirs).
/// Drive-root repos are treated as accidents and ignored.
fn repo_root_for(dir: &Path) -> Option<PathBuf> {
    let out = run_git(dir, &["rev-parse", "--show-toplevel"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    let root = PathBuf::from(s);
    root.parent()?; // None for drive roots like C:/
    Some(root)
}

/// Folders opened as a vault this session (every scan records one). Git needs
/// them: with no repo anywhere above a note, its history belongs at the vault
/// root, not in whichever subfolder the note happens to sit in.
fn vault_roots() -> &'static Mutex<Vec<PathBuf>> {
    static ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(Vec::new()))
}

fn remember_vault_root(root: &Path) {
    if let Ok(mut roots) = vault_roots().lock() {
        if !roots.iter().any(|r| r == root) {
            roots.push(root.to_path_buf());
        }
    }
}

/// The deepest remembered vault root that contains `file`.
fn vault_root_for(file: &Path) -> Option<PathBuf> {
    let roots = vault_roots().lock().ok()?;
    roots
        .iter()
        .filter(|r| file.starts_with(r))
        .max_by_key(|r| r.components().count())
        .cloned()
}

/// Where `file`'s history lives: the repo that already encloses it, else the
/// vault root, else its own folder. One anchor for saves, renames and deletes —
/// two anchors put two `.git` dirs in one vault and left rename commits failing
/// on a pathspec forever. Never initializes a second repo inside one that
/// already covers the file: `repo_root_for` walks up first.
fn git_anchor_for(file: &Path) -> Option<PathBuf> {
    let dir = file.parent().filter(|p| !p.as_os_str().is_empty())?;
    if let Some(root) = repo_root_for(dir) {
        return Some(root);
    }
    Some(vault_root_for(file).unwrap_or_else(|| dir.to_path_buf()))
}

/// `gc.auto=0` on every add/commit means no save ever waits on a repack — so
/// the repack has to happen somewhere, or loose objects pile up forever (one
/// commit per autosave). Once per repo per app run, after a successful commit,
/// spawn `git gc --auto` detached and forget it: with git's default threshold
/// it is an instant no-op unless objects actually accumulated, and a failure
/// costs nothing — the next launch tries again. Never awaited: the save path
/// stays exactly as fast as before. (imba-roadmap §W1.3, second half.)
fn maybe_repack(root: &Path) {
    // under `cargo test` a detached gc can outlive the TempDir and hold its
    // files open on Windows — the tests exercise commits, not compaction
    if cfg!(test) {
        return;
    }
    static DONE: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    let done = DONE.get_or_init(|| Mutex::new(Vec::new()));
    let Ok(mut roots) = done.lock() else { return };
    if roots.iter().any(|r| r == root) {
        return;
    }
    roots.push(root.to_path_buf());
    let mut cmd = std::process::Command::new("git");
    // autoDetach off: we are already the detachment
    cmd.arg("-C")
        .arg(root)
        .args(["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd.spawn();
}

/// Stage `paths` (deletions included — `add -A`) and commit them as one
/// history entry. `anchor` locates the repo; one is initialized there if none
/// exists. Shared by per-save autocommit and the rename/delete operations.
fn git_commit_paths(anchor: &Path, paths: &[&str], message: &str) -> Result<(), String> {
    let root = match repo_root_for(anchor) {
        Some(r) => r,
        None => {
            let out = run_git(anchor, &["init", "-b", "main"])?;
            if !out.status.success() {
                return Err(format!("git init: {}", String::from_utf8_lossy(&out.stderr)));
            }
            anchor.to_path_buf()
        }
    };
    // A path that neither exists nor is tracked (e.g. the old name of a note
    // renamed before its vault ever saw git) would make add/commit pathspecs
    // fatal — drop those; there is nothing to record about them anyway.
    let paths: Vec<&str> = paths
        .iter()
        .copied()
        .filter(|p| {
            Path::new(p).exists()
                || run_git(&root, &["ls-files", "--error-unmatch", "--", p])
                    .is_ok_and(|o| o.status.success())
        })
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    // autocrlf off: history must store the exact bytes we saved, or restores
    // would change line endings. gc.auto=0: a save must never wait on a
    // surprise repack.
    let mut add: Vec<&str> =
        vec!["-c", "core.autocrlf=false", "-c", "gc.auto=0", "add", "-A", "--"];
    add.extend(&paths);
    let out = run_git(&root, &add)?;
    if !out.status.success() {
        let said = git_said(&out);
        // `*.md` in the user's .gitignore makes every add exit 1 — forever,
        // once per save, and until now silently.
        if said.contains(".gitignore") || said.contains("ignored by") {
            return Err(
                "Your .gitignore excludes this note, so git isn't keeping its history."
                    .to_string(),
            );
        }
        return Err(format!("git couldn't stage this note: {said}"));
    }
    // gpgsign off and --no-verify: a save must never hang on a prompt, and an
    // enclosing repo's own pre-commit hook must never rewrite the file we just
    // wrote — hooks run in the working tree, and one rewrote a note mid-save.
    let mut commit: Vec<&str> = vec![
        "-c",
        "user.name=Sandy",
        "-c",
        "user.email=autosave@sandy.local",
        "-c",
        "core.autocrlf=false",
        "-c",
        "gc.auto=0",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "-m",
        message,
        "--",
    ];
    commit.extend(paths);
    let out = run_git(&root, &commit)?;
    if !out.status.success() {
        let msg = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        // empty diff is the normal quiet case, not an error
        if !msg.contains("nothing to commit") && !msg.contains("no changes added") {
            return Err(format!("git couldn't record this change: {}", git_said(&out)));
        }
    }
    maybe_repack(&root);
    Ok(())
}

fn do_git_autocommit(path: &str) -> Result<(), String> {
    let file = Path::new(path);
    let anchor = git_anchor_for(file).ok_or_else(|| format!("{path}: no parent"))?;
    let name = note_name(file);
    git_commit_paths(&anchor, &[path], &format!("sandy: {name}"))
}

/* ── vault: scan / search / create ─────────────────────────────────────────
 * Read-only helpers over a notes folder. The scan and search are disposable
 * indexes — files on disk stay the only truth.
 */

const NOTE_EXTS: [&str; 3] = ["md", "markdown", "txt"];
const SCAN_MAX_DEPTH: u32 = 12;
const SCAN_MAX_FILES: usize = 20_000;
const SEARCH_MAX_HITS: usize = 200;
const SEARCH_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

fn is_note(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some(e) if NOTE_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x))
    )
}

/// `capped` is set when a cap cut the walk short — a real directory went
/// unvisited. The dot-folder and node_modules skips are policy, applied to
/// every vault alike, and deliberately don't count: they are not doubt.
fn scan_into(base: &Path, dir: &Path, out: &mut Vec<String>, depth: u32, capped: &mut bool) {
    if depth > SCAN_MAX_DEPTH || out.len() >= SCAN_MAX_FILES {
        *capped = true;
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue; // .git, .obsidian, other tool dirs
        }
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            if name.eq_ignore_ascii_case("node_modules") {
                continue;
            }
            scan_into(base, &path, out, depth + 1, capped);
        } else if ft.is_file() && is_note(&path) {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// The scan, plus whether it hit its own caps. A capped list proves nothing
/// about what the vault does *not* contain — the one caller that reasons from
/// absence (orphaned_attachments) has to know.
fn scan_vault_capped(root: &str) -> Result<(Vec<String>, bool), String> {
    let base = PathBuf::from(root);
    /* The one read failure that must speak: the root itself. An unreadable
     * subfolder stays a quiet skip, but a root Windows refuses (a permission
     * flip, a vanished network share) used to scan as an empty vault — and the
     * sidebar then lied "No notes here yet." (s57 #V6). */
    // reason only — the App prefix already says "Couldn't read this folder."
    if let Err(e) = std::fs::read_dir(&base) {
        return Err(format!("{}.", plain_os_error(&e)));
    }
    // Every scan says which folder the user is treating as a vault; git keeps
    // it as the fallback anchor so history lands in one place (git_anchor_for).
    remember_vault_root(&base);
    let mut out = Vec::new();
    let mut capped = false;
    scan_into(&base, &base, &mut out, 0, &mut capped);
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok((out, capped))
}

/// The scan for callers that only *augment* on its answer (the rename walk's
/// link rewrite, alias collection): an unreadable root reads as no notes, and
/// the operation simply touches nothing extra. The user-facing surfaces go
/// through `scan_vault`, which does report it.
fn do_scan_vault(root: &str) -> Vec<String> {
    scan_vault_capped(root).map(|(v, _)| v).unwrap_or_default()
}

/// Relative paths ('/'-separated) of every note under `root`.
#[tauri::command]
async fn scan_vault(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_vault_capped(&root).map(|(v, _)| v))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct SearchHit {
    rel: String,
    line: u32,
    text: String,
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct SearchResult {
    hits: Vec<SearchHit>,
    /// The hit cap cut the walk short, alphabetically — what you see is not
    /// all there is, and the panel has to say so.
    truncated: bool,
}

fn do_search_vault(root: &str, query: &str) -> Result<SearchResult, String> {
    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    let mut truncated = false;
    if needle.trim().is_empty() {
        return Ok(SearchResult { hits, truncated });
    }
    let base = PathBuf::from(root);
    // an unreadable root must not read as "No matches." (s57 #V6)
    let (files, _) = scan_vault_capped(root)?;
    'files: for rel in files {
        let path = base.join(&rel);
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > SEARCH_MAX_FILE_BYTES {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    rel: rel.clone(),
                    line: (i + 1) as u32,
                    text: line.trim().chars().take(300).collect(),
                });
                if hits.len() >= SEARCH_MAX_HITS {
                    truncated = true;
                    break 'files;
                }
            }
        }
    }
    Ok(SearchResult { hits, truncated })
}

/// Case-insensitive substring scan over every note. Personal-scale by design
/// (council: no FTS index until scanning is actually slow).
#[tauri::command]
async fn search_vault(root: String, query: String) -> Result<SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || do_search_vault(&root, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct NoteAliases {
    rel: String,
    aliases: Vec<String>,
}

fn clean_alias(raw: &str) -> Option<String> {
    let t = raw.trim();
    let unquoted = if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        t[1..t.len() - 1].trim()
    } else {
        t
    };
    (!unquoted.is_empty()).then(|| unquoted.to_string())
}

/// Frontmatter `aliases:`/`alias:` values — inline `[a, b]`, a `- item` block
/// list, or a comma-separated string; quotes stripped. Empty without a closed
/// frontmatter block. Mirrors `frontmatterAliases` in src/editor/frontmatter.ts.
fn parse_frontmatter_aliases(content: &str) -> Vec<String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut in_list = false;
    for line in lines {
        if line == "---" || line == "..." {
            return out;
        }
        if in_list {
            let lt = line.trim_start();
            if let Some(item) = lt.strip_prefix("- ") {
                out.extend(clean_alias(item));
                continue;
            }
            if lt == "-" {
                continue;
            }
            in_list = false;
        }
        let rest = if let Some(r) = line.strip_prefix("aliases:") {
            r
        } else if let Some(r) = line.strip_prefix("alias:") {
            r
        } else {
            continue;
        };
        let rest = rest.trim();
        if rest.is_empty() {
            in_list = true;
        } else {
            let inner = rest
                .strip_prefix('[')
                .and_then(|r| r.strip_suffix(']'))
                .unwrap_or(rest);
            for item in inner.split(',') {
                out.extend(clean_alias(item));
            }
        }
    }
    Vec::new() // no closing fence — a lone leading "---" is just a rule
}

/// Aliases live in frontmatter, which starts at byte 0 — the head of the file
/// is all this scan ever needs. 8 KB of YAML frontmatter is far past any real
/// note; one whose fence closes beyond that silently indexes as alias-less.
const ALIAS_HEAD_BYTES: u64 = 8192;

fn do_scan_aliases(root: &str) -> Vec<NoteAliases> {
    use std::io::Read;
    let base = PathBuf::from(root);
    let mut out = Vec::new();
    let mut buf = Vec::with_capacity(ALIAS_HEAD_BYTES as usize);
    for rel in do_scan_vault(root) {
        let Ok(file) = std::fs::File::open(base.join(&rel)) else { continue };
        buf.clear();
        if file.take(ALIAS_HEAD_BYTES).read_to_end(&mut buf).is_err() {
            continue;
        }
        // a truncated trailing UTF-8 char lossy-decodes past the closing fence,
        // where the parser never looks
        let aliases = parse_frontmatter_aliases(&String::from_utf8_lossy(&buf));
        if !aliases.is_empty() {
            out.push(NoteAliases { rel, aliases });
        }
    }
    out
}

/// Frontmatter aliases of every note (alias-less notes omitted). Read-only,
/// same personal-scale scan discipline as search_vault.
#[tauri::command]
async fn scan_aliases(root: String) -> Result<Vec<NoteAliases>, String> {
    tauri::async_runtime::spawn_blocking(move || do_scan_aliases(&root))
        .await
        .map_err(|e| e.to_string())
}

fn do_create_note(path: &str) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(dir) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't make its folder — {}.", plain_os_error(&e)))?;
    }
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(_) => Ok(()),
        // already-exists is fine: caller opens the existing note, never clobbers
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("{}.", plain_os_error(&e))),
    }
}

/// Create an empty note (missing folders included). Never overwrites.
#[tauri::command]
async fn create_note(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_create_note(&path))
        .await
        .map_err(|e| e.to_string())?
}

/* ── rename / delete ───────────────────────────────────────────────────────
 * The only operations that touch files the user did not open, so they carry
 * the strictest discipline: renaming (or moving) rewrites the links that
 * resolved to the note — [[wiki]] and [text](note.md) alike — vault-wide,
 * through the same gated atomic writer as every save (fenced/inline code
 * skipped); deleting moves the note and the attachments only it was using to
 * the system trash — Sandy never permanently deletes.
 */

#[derive(serde::Serialize, Debug, PartialEq)]
struct SkippedFile {
    rel: String,
    /// Why this note was left out, as a phrase to show next to its name.
    reason: String,
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct RenameResult {
    new_rel: String,
    /// Rel paths whose links were rewritten (and saved). Only links that
    /// resolved to this note are ever touched — a same-stem link that pointed
    /// somewhere else is left exactly as the user wrote it.
    rewritten: Vec<String>,
    /// Rel paths where a rewrite was needed but refused (e.g. an external
    /// edit landed mid-operation) — their links still say the old name.
    failed: Vec<String>,
    /// Notes the rewrite could not even read, and why. The rename is already
    /// done when the walk starts, so the one thing owed is a truthful report.
    skipped: Vec<SkippedFile>,
    /// How many notes the rewrite looked at (bounded by the scan's own
    /// SCAN_MAX_FILES / SCAN_MAX_DEPTH caps).
    scanned: u32,
    /// Why the operation isn't in git history, when it isn't.
    git_error: Option<String>,
}

/// One Windows-safe file-name segment: no separators or forbidden characters,
/// no reserved device name, no trailing dot/space. Mirrors safeNoteRelPath
/// (vault.ts); this side is authoritative. A move validates every segment of
/// its destination with it, which is also what keeps a destination inside the
/// vault — ".." and a drive letter are both refused here.
fn valid_new_name(name: &str) -> bool {
    const RESERVED: [&str; 24] = [
        "con", "prn", "aux", "nul", "conin$", "conout$", "com1", "com2", "com3", "com4", "com5",
        "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7",
        "lpt8", "lpt9",
    ];
    /* Windows resolves a device name from the segment up to its FIRST dot,
     * with trailing spaces stripped — `CON.md`, `NUL.txt`, `COM1.notes` are
     * all the device. Test the stem the OS tests, not the whole segment; the
     * whole-segment compare accepted every one of those (s51 #25). */
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    !name.is_empty()
        && name.len() <= 200
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name.chars().any(|c| {
            matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\') || (c as u32) < 0x20
        })
        && !RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// Do two paths name the same file on disk? Canonicalizing asks the filesystem
/// instead of assuming its case rules — the only honest answer when a rename
/// differs from its target by case alone.
fn is_same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false, // can't tell: treat them as different and refuse
    }
}

fn strip_note_ext(rel: &str) -> &str {
    let lower = rel.to_lowercase();
    for ext in NOTE_EXTS {
        if lower.ends_with(&format!(".{ext}")) {
            return &rel[..rel.len() - ext.len() - 1];
        }
    }
    rel
}

/// `/`-separated and lowercased — the one shape every path comparison here
/// uses, because the Windows filesystem is case-insensitive.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// Folder part of a rel path; "" at the vault root.
fn dir_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(d, _)| d)
}

/* ── wiki resolution ───────────────────────────────────────────────────────
 * Mirror of `resolveWikiTarget` in src/vault/vault.ts, and the side the writer
 * trusts. A rename may only touch links that actually resolved to the renamed
 * note: a bare [[index]] in a vault with three of them belongs to exactly one,
 * and rewriting the other two corrupts them without a word. The two resolvers
 * must not drift — change them together.
 */

/// The frontend resolver's three match tiers — exact rel path → stem anywhere →
/// path suffix — turned inside out into three maps. Each keeps the first file
/// in the scan's own (case-insensitive) order, which is what "the earliest loop
/// with the earliest match wins" means once the loops are gone.
struct WikiIndex {
    exact: HashMap<String, String>,
    stem: HashMap<String, String>,
    suffix: HashMap<String, String>,
}

impl WikiIndex {
    fn build(files: &[String]) -> WikiIndex {
        let mut idx = WikiIndex {
            exact: HashMap::new(),
            stem: HashMap::new(),
            suffix: HashMap::new(),
        };
        for f in files {
            let full = norm_path(f);
            let noext = strip_note_ext(&full).to_string();
            idx.exact.entry(full).or_insert_with(|| f.clone());
            idx.exact.entry(noext.clone()).or_insert_with(|| f.clone());
            let mut tail = noext.as_str();
            idx.stem
                .entry(tail.rsplit('/').next().unwrap_or(tail).to_string())
                .or_insert_with(|| f.clone());
            while let Some((_, rest)) = tail.split_once('/') {
                idx.suffix.entry(rest.to_string()).or_insert_with(|| f.clone());
                tail = rest;
            }
        }
        idx
    }

    /// Rel path a `[[target]]` lands on, or None when nothing does.
    fn resolve(&self, target: &str) -> Option<&str> {
        // `#heading` / `|alias` are not part of the path — strip them here, the
        // way `wikiTargetName` does on the TS side, so the two resolvers answer
        // a raw `[[Note#Heading]]` inner alike. Both callers already pre-strip;
        // doing it once here is what keeps the mirror promise true for the next.
        let head = &target[..target.find(['#', '|']).unwrap_or(target.len())];
        let t = norm_path(head.trim());
        if t.is_empty() {
            return None;
        }
        self.exact
            .get(&t)
            .or_else(|| self.stem.get(&t))
            .or_else(|| self.suffix.get(&t))
            .map(String::as_str)
    }
}

/* ── markdown link destinations ────────────────────────────────────────────
 * `[text](note.md)` is a link to a note like any other, so a rename has to
 * carry it too. Unlike a wiki target it is relative to the folder of the note
 * holding it, which is also why moving a note rewrites its own destinations.
 */

/// A destination that isn't a path inside the vault — a URL scheme, a
/// protocol-relative `//host`, an absolute path, a drive letter. Left as written.
fn is_external_dest(dest: &str) -> bool {
    if dest.starts_with('/') || dest.starts_with('\\') {
        return true;
    }
    match dest.split_once(':') {
        Some((scheme, _)) => {
            !scheme.is_empty()
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        None => false,
    }
}

/// Vault-rel path a destination points at, resolved against `dir`. None when it
/// climbs out of the vault — those are somebody else's files.
fn resolve_rel(dir: &str, dest: &str) -> Option<String> {
    let dest = dest.replace('\\', "/");
    let mut segs: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    for part in dest.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                segs.pop()?; // climbed past the vault root
            }
            p => segs.push(p),
        }
    }
    (!segs.is_empty()).then(|| segs.join("/"))
}

/// How `target` is written from inside `dir` ("a/b" → "a/c/x.md" = "../c/x.md").
fn rel_from_dir(dir: &str, target: &str) -> String {
    let from: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    let to: Vec<&str> = target.split('/').collect();
    let mut same = 0;
    while same < from.len() && same + 1 < to.len() && norm_path(from[same]) == norm_path(to[same]) {
        same += 1;
    }
    let mut out = String::new();
    for _ in same..from.len() {
        out.push_str("../");
    }
    out.push_str(&to[same..].join("/"));
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `%20` and friends back to bytes, for comparing a destination with a path on
/// disk. Anything that isn't a valid escape is left exactly as it was.
fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex_val(b[i + 1]), hex_val(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A path as a link destination. Outside angle brackets a space would end the
/// destination and a paren would close it early; inside them only the brackets
/// themselves need escaping.
fn encode_dest(path: &str, bracketed: bool) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            '%' => out.push_str("%25"),
            '<' if bracketed => out.push_str("%3C"),
            '>' if bracketed => out.push_str("%3E"),
            ' ' if !bracketed => out.push_str("%20"),
            '(' if !bracketed => out.push_str("%28"),
            ')' if !bracketed => out.push_str("%29"),
            _ => out.push(c),
        }
    }
    out
}

/// Inline code spans of one line as byte ranges (CommonMark backtick rule:
/// a run of N backticks closes only at the next run of exactly N).
fn inline_code_spans(line: &str) -> Vec<(usize, usize)> {
    let b = line.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        let mut n = 0;
        while i < b.len() && b[i] == b'`' {
            n += 1;
            i += 1;
        }
        let mut j = i;
        while j < b.len() {
            if b[j] != b'`' {
                j += 1;
                continue;
            }
            let mut m = 0;
            while j < b.len() && b[j] == b'`' {
                m += 1;
                j += 1;
            }
            if m == n {
                spans.push((start, j));
                i = j;
                break;
            }
        }
    }
    spans
}

/// Byte ranges of every `[text](destination)` destination on one line, and
/// whether it was written inside `<angle brackets>`. The range covers the
/// destination text only — the title, the parens and the label never move.
fn md_link_dests(line: &str) -> Vec<(usize, usize, bool)> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] != b']' || b[i + 1] != b'(' || !line[..i].contains('[') {
            i += 1;
            continue;
        }
        let mut j = i + 2;
        while j < b.len() && b[j] == b' ' {
            j += 1;
        }
        let span = if j < b.len() && b[j] == b'<' {
            line[j + 1..].find('>').map(|k| (j + 1, j + 1 + k, true))
        } else {
            let mut k = j;
            while k < b.len() && b[k] != b')' && !b[k].is_ascii_whitespace() {
                k += 1;
            }
            Some((j, k, false))
        };
        // no closing paren on the line: not an inline link, leave it alone
        match span.filter(|&(s, e, _)| e > s && line[e..].contains(')')) {
            Some(found) => {
                i = found.1;
                out.push(found);
            }
            None => i += 2,
        }
    }
    out
}

/// Fenced-code tracking for a line-by-line walk: a fence opens on ``` or ~~~
/// and closes on at least as many of the same character with nothing after it.
/// Everything between is code, never a link.
#[derive(Default)]
struct Fences(Option<(char, usize)>);

impl Fences {
    /// True when this line (no EOL) is inside a fenced block, its fence included.
    fn fenced(&mut self, body: &str) -> bool {
        let t = body.trim_start_matches('\u{feff}').trim_start();
        match self.0 {
            Some((ch, n)) => {
                let run = t.chars().take_while(|&c| c == ch).count();
                if run >= n && t[run..].trim().is_empty() {
                    self.0 = None;
                }
                true
            }
            None => {
                if let Some(ch @ ('`' | '~')) = t.chars().next() {
                    let run = t.chars().take_while(|&c| c == ch).count();
                    if run >= 3 {
                        self.0 = Some((ch, run));
                        return true;
                    }
                }
                false
            }
        }
    }
}

/// Everything one vault-wide link rewrite needs, built once per rename and then
/// pointed at each note in turn with `at()`.
struct Rewrite {
    /// the vault as the links on disk know it — that is, before the rename.
    /// Resolution happens here and nowhere else.
    old_index: WikiIndex,
    /// does a bare `[[new stem]]` still land on this note? When the new name
    /// exists elsewhere too, bare links have to be written as paths instead.
    bare_reaches: bool,
    base: PathBuf,
    old_rel: String,
    new_rel: String,
    new_rel_noext: String,
    new_stem: String,
    /// folder the current note's relative destinations resolve against
    from_dir: String,
    /// folder they must be written from — differs only for the note that moved
    to_dir: String,
    /// the current note *is* the one that moved: every relative destination it
    /// holds (images included) now points a folder away from where it means
    moved_self: bool,
}

impl Rewrite {
    fn new(
        base: &Path,
        files_before: &[String],
        files_after: &[String],
        old_rel: &str,
        new_rel: &str,
    ) -> Rewrite {
        let new_rel_noext = strip_note_ext(new_rel).to_string();
        let new_stem = new_rel_noext.rsplit('/').next().unwrap_or(&new_rel_noext).to_string();
        let after = WikiIndex::build(files_after);
        let bare_reaches = after.resolve(&new_stem).map(norm_path) == Some(norm_path(new_rel));
        Rewrite {
            old_index: WikiIndex::build(files_before),
            bare_reaches,
            base: base.to_path_buf(),
            old_rel: old_rel.to_string(),
            new_rel: new_rel.to_string(),
            new_rel_noext,
            new_stem,
            from_dir: String::new(),
            to_dir: String::new(),
            moved_self: false,
        }
    }

    /// Point the rewrite at one note of the vault (rel path, `/`-separated).
    fn at(&mut self, rel: &str) {
        let dir = dir_of(rel).to_string();
        self.moved_self = norm_path(rel) == norm_path(&self.new_rel)
            && norm_path(dir_of(&self.old_rel)) != norm_path(&dir);
        self.from_dir =
            if self.moved_self { dir_of(&self.old_rel).to_string() } else { dir.clone() };
        self.to_dir = dir;
    }
}

/// Rewrite the `[[wiki-link]]` targets of one line (no EOL) that resolved to
/// the renamed note. Alias / `#heading` tails, surrounding whitespace, and
/// every other byte survive — only the target text itself is replaced.
fn rewrite_wiki_line(line: &str, ctx: &Rewrite) -> Option<String> {
    let code = inline_code_spans(line);
    let in_code = |a: usize, b: usize| code.iter().any(|&(s, e)| a < e && b > s);

    let mut out = String::new();
    let mut copied = 0; // everything before this byte offset is already in `out`
    let mut changed = false;
    let mut i = 0;
    while let Some(open) = line[i..].find("[[") {
        let open = i + open;
        let Some(close) = line[open + 2..].find("]]") else { break };
        let close = open + 2 + close; // offset of "]]"
        i = open + 2; // resume after "[[" even when this link is skipped
        let inner = &line[open + 2..close];
        if inner.contains('[') || inner.contains(']') || in_code(open, close + 2) {
            continue;
        }
        // target = inner before any `#heading` or `|alias` tail
        let target_end = inner.find(['#', '|']).unwrap_or(inner.len());
        let target = &inner[..target_end];
        let t = target.trim();
        if t.is_empty() {
            continue;
        }
        // the only question that matters: did *this* link land on the note that
        // was renamed? A same-stem link that resolved elsewhere is not ours.
        if ctx.old_index.resolve(t).map(norm_path) != Some(norm_path(&ctx.old_rel)) {
            continue;
        }
        // a target written as a path stays a path, so it follows a move; a bare
        // one stays bare unless bare no longer reaches the note
        let replacement = if t.contains('/') || t.contains('\\') || !ctx.bare_reaches {
            &ctx.new_rel_noext
        } else {
            &ctx.new_stem
        };
        if replacement == t {
            continue; // already says the right thing (a move under the same name)
        }
        let t_start = open + 2 + (target.len() - target.trim_start().len());
        let t_close = t_start + t.len();
        out.push_str(&line[copied..t_start]);
        out.push_str(replacement);
        copied = t_close;
        changed = true;
        i = close + 2;
    }
    if !changed {
        return None;
    }
    out.push_str(&line[copied..]);
    Some(out)
}

/// The same for `[text](note.md)` destinations. Only relative paths inside the
/// vault are touched: URLs, absolute paths and `#anchor`-only links are not
/// Sandy's to edit, and a destination that resolves somewhere else is left
/// alone exactly like a wiki link that resolved elsewhere.
fn rewrite_md_line(line: &str, ctx: &Rewrite) -> Option<String> {
    let code = inline_code_spans(line);
    let mut out = String::new();
    let mut copied = 0;
    let mut changed = false;
    for (start, end, bracketed) in md_link_dests(line) {
        if code.iter().any(|&(s, e)| start < e && end > s) {
            continue;
        }
        let raw = &line[start..end];
        // a `#heading` tail belongs to the destination but not to the path
        let path_part = match raw.find('#') {
            Some(h) => &raw[..h],
            None => raw,
        };
        if path_part.is_empty() {
            continue; // "#anchor" — same page, no path to fix
        }
        let decoded = percent_decode(path_part);
        if is_external_dest(&decoded) {
            continue;
        }
        let Some(points_at) = resolve_rel(&ctx.from_dir, &decoded) else { continue };
        let new_path = if norm_path(&points_at) == norm_path(&ctx.old_rel) {
            rel_from_dir(&ctx.to_dir, &ctx.new_rel)
        } else if ctx.moved_self && ctx.base.join(&points_at).exists() {
            // the note moved: what it points at did not
            rel_from_dir(&ctx.to_dir, &points_at)
        } else {
            continue;
        };
        let new_dest = encode_dest(&new_path, bracketed);
        if new_dest == path_part {
            continue;
        }
        out.push_str(&line[copied..start]);
        out.push_str(&new_dest);
        copied = start + path_part.len();
        changed = true;
    }
    if !changed {
        return None;
    }
    out.push_str(&line[copied..]);
    Some(out)
}

fn rewrite_line(line: &str, ctx: &Rewrite) -> Option<String> {
    let wiki = rewrite_wiki_line(line, ctx);
    let base = wiki.as_deref().unwrap_or(line);
    match rewrite_md_line(base, ctx) {
        Some(both) => Some(both),
        None => wiki,
    }
}

/// Vault-wide link rewrite for one document. Line endings, BOM, and every
/// unrelated byte are preserved; fenced code blocks are skipped wholesale.
/// Returns None when nothing in it pointed at the renamed note.
fn rewrite_links(content: &str, ctx: &Rewrite) -> Option<String> {
    let mut out = String::with_capacity(content.len());
    let mut changed = false;
    let mut fences = Fences::default();
    for piece in content.split_inclusive('\n') {
        let body_end = piece.trim_end_matches('\n').trim_end_matches('\r').len();
        let (body, eol) = piece.split_at(body_end);
        if fences.fenced(body) {
            out.push_str(piece);
            continue;
        }
        match rewrite_line(body, ctx) {
            Some(newline) => {
                changed = true;
                out.push_str(&newline);
                out.push_str(eol);
            }
            None => out.push_str(piece),
        }
    }
    changed.then_some(out)
}

/// Attachment files one note points at, as vault-rel paths, restricted to its
/// own `attachments/` folder. Fenced code is skipped so an example in a code
/// block never counts as a use.
fn note_attachments(content: &str, note_rel: &str) -> Vec<String> {
    let dir = dir_of(note_rel);
    let folder =
        if dir.is_empty() { "attachments/".to_string() } else { format!("{dir}/attachments/") };
    let folder = folder.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut fences = Fences::default();
    for piece in content.split_inclusive('\n') {
        let body = piece.trim_end_matches('\n').trim_end_matches('\r');
        if fences.fenced(body) {
            continue;
        }
        let code = inline_code_spans(body);
        for (start, end, _) in md_link_dests(body) {
            if code.iter().any(|&(s, e)| start < e && end > s) {
                continue;
            }
            let raw = &body[start..end];
            let path_part = raw.split('#').next().unwrap_or(raw);
            let decoded = percent_decode(path_part);
            if decoded.is_empty() || is_external_dest(&decoded) {
                continue;
            }
            let Some(rel) = resolve_rel(dir, &decoded) else { continue };
            if rel.to_lowercase().starts_with(&folder)
                && !out.iter().any(|o| norm_path(o) == norm_path(&rel))
            {
                out.push(rel);
            }
        }
    }
    out
}

fn do_rename_note(root: &str, old_rel: &str, new_name: &str) -> Result<RenameResult, String> {
    // A name carrying a separator is a move: the whole thing is a path from the
    // vault root. Every segment is validated exactly like a single name, which
    // is also why the destination can never leave the vault — "..", a drive
    // letter and a device name are all refused before anything moves.
    let new_name = new_name.trim().replace('\\', "/");
    let moving = new_name.contains('/');
    if !new_name.split('/').all(valid_new_name) {
        return Err(format!("\u{201c}{new_name}\u{201d} is not a usable note name"));
    }
    // The source went through none of that, and the containment promised above
    // was only ever true of the destination: `Path::join` discards its base
    // entirely for an absolute or UNC path and follows "..", so an unchecked
    // `old_rel` walks the rename out of the vault — and `git_anchor_for` then
    // runs `git init` wherever it landed. Same guard, applied to both ends.
    if !old_rel.split('/').all(valid_new_name) {
        return Err("It isn't a note inside this vault.".to_string());
    }
    let base = PathBuf::from(root);
    let old_path = base.join(old_rel);
    if !old_path.is_file() {
        return Err("The note is already gone from the folder.".to_string());
    }
    let ext = old_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_string();
    let new_rel = match (moving, old_rel.rsplit_once('/')) {
        (true, _) => format!("{new_name}.{ext}"),
        (false, Some((dir, _))) => format!("{dir}/{new_name}.{ext}"),
        (false, None) => format!("{new_name}.{ext}"),
    };
    if new_rel == old_rel {
        return Ok(RenameResult {
            new_rel,
            rewritten: vec![],
            failed: vec![],
            skipped: vec![],
            scanned: 0,
            git_error: None,
        });
    }
    let new_path = base.join(&new_rel);
    // Windows FS is case-insensitive: "note" → "Note" renames the same file in
    // place, so "it exists" is expected there — and only there. On a
    // case-sensitive directory (Win10+ per-dir case sensitivity, WSL, SMB) a
    // differently-cased note is a different file, and fs::rename replaces it
    // without a word. Ask the filesystem which it is instead of guessing.
    let case_only = new_rel.to_lowercase() == old_rel.to_lowercase();
    if new_path.exists() && !is_same_file(&old_path, &new_path) {
        return Err(format!("\u{201c}{new_name}\u{201d} already exists"));
    }
    /* Remember the deepest ancestor that already existed: if the move itself
     * then fails, everything created below it is removed again — "skip, never
     * half-write" includes not leaving an empty folder chain behind (s51 #33).
     * remove_dir refuses a non-empty directory, so the walk-back can never
     * take anything that was already there or that something else just put in. */
    let preexisting_dir = new_path
        .parent()
        .and_then(|p| p.ancestors().find(|a| a.exists()).map(Path::to_path_buf));
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}.", plain_os_error(&e)))?;
    }
    if let Err(e) = std::fs::rename(&old_path, &new_path) {
        if let (Some(parent), Some(stop)) = (new_path.parent(), preexisting_dir.as_deref()) {
            let mut dir = parent;
            while dir != stop && std::fs::remove_dir(dir).is_ok() {
                let Some(up) = dir.parent() else { break };
                dir = up;
            }
        }
        return Err(format!("{}.", plain_os_error(&e)));
    }
    // keep the disk-authority guard tracking the file under its new path
    if let Ok(mut map) = known_bytes().lock() {
        if let Some(fp) = map.remove(&old_path) {
            map.insert(new_path.clone(), fp);
        }
    }

    let mut rewritten = Vec::new();
    let mut failed = Vec::new();
    let mut skipped = Vec::new();
    let mut scanned = 0u32;
    // A case-only rename resolves identically (links are matched
    // case-insensitively), so no file needs to change.
    if !case_only {
        let files_after = do_scan_vault(root);
        // The index the links on disk were written against is the vault as it
        // was a moment ago, with this note still under its old name.
        let mut files_before: Vec<String> = files_after
            .iter()
            .map(|r| {
                if norm_path(r) == norm_path(&new_rel) { old_rel.to_string() } else { r.clone() }
            })
            .collect();
        files_before.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        let mut ctx = Rewrite::new(&base, &files_before, &files_after, old_rel, &new_rel);
        for rel in files_after {
            let p = base.join(&rel);
            scanned += 1;
            // No size cap here: the search cap exists to keep a keystroke
            // cheap, and correctness is not allowed to borrow it.
            let content = match std::fs::read_to_string(&p) {
                Ok(c) => c,
                Err(e) => {
                    skipped.push(SkippedFile { rel, reason: why_skipped(&e) });
                    continue;
                }
            };
            ctx.at(&rel);
            let Some(updated) = rewrite_links(&content, &ctx) else {
                continue;
            };
            // the bytes just read are the baseline this rewrite derives from
            remember(&p, content.as_bytes());
            let path_str = p.to_string_lossy().into_owned();
            match do_save_doc(&path_str, &updated, false) {
                Ok(()) => rewritten.push(rel),
                Err(_) => failed.push(rel), // skip, never half-write; caller surfaces it
            }
        }
    }

    // one history entry for the whole operation — history never blocks it
    let old_stem = strip_note_ext(old_rel).rsplit('/').next().unwrap_or(old_rel).to_string();
    let mut paths: Vec<String> = vec![
        old_path.to_string_lossy().into_owned(),
        new_path.to_string_lossy().into_owned(),
    ];
    paths.extend(rewritten.iter().map(|r| base.join(r).to_string_lossy().into_owned()));
    let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    // the same anchor a save would use, so one vault never grows two repos
    let anchor = git_anchor_for(&new_path).unwrap_or_else(|| base.clone());
    let git_error = git_commit_paths(
        &anchor,
        &path_refs,
        &format!("sandy: rename {old_stem} -> {new_name}"),
    )
    .err();

    Ok(RenameResult { new_rel, rewritten, failed, skipped, scanned, git_error })
}

/// Rename a note and rewrite every link to it across the vault. A `new_name`
/// containing `/` is a path from the vault root — that is, a move; the
/// extension is preserved either way.
#[tauri::command]
async fn rename_note(
    root: String,
    old_rel: String,
    new_name: String,
) -> Result<RenameResult, String> {
    tauri::async_runtime::spawn_blocking(move || do_rename_note(&root, &old_rel, &new_name))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct DeleteResult {
    /// Attachments that went to the trash with the note, as vault-rel paths.
    /// Deleting a note used to orphan its images forever and silently; taking
    /// them is only safe if it is also said out loud.
    trashed: Vec<String>,
    /// Why the attachment sweep's answer is incomplete, when it is: the sweep
    /// stood down (an unreadable note, a capped scan), or some attachments
    /// refused to move. An empty `trashed` is otherwise indistinguishable
    /// from "no attachments", and absence must speak (s51 #22).
    sweep_skipped: Option<String>,
    /// Why the deletion isn't in git history, when it isn't. The note is in the
    /// trash either way, so this is never an error.
    git_error: Option<String>,
}

/// Attachments of the deleted note that no other note in the vault mentions.
/// Deliberately broad on the "mentions" side: a file name appearing anywhere in
/// another note — prose, a code fence, a link — keeps the file. So does a note
/// that can't be read, since nothing can be proven about it; the sweep then
/// stands down entirely and takes nothing — and `Err` carries why, because a
/// silent stand-down reads exactly like "no attachments" (s51 #22).
fn orphaned_attachments(root: &Path, note_rel: &str, content: &str) -> Result<Vec<String>, String> {
    let candidates = note_attachments(content, note_rel);
    if candidates.is_empty() {
        return Ok(candidates);
    }
    let needles: Vec<(String, String)> = candidates
        .iter()
        .map(|c| {
            let name = c.rsplit('/').next().unwrap_or(c).to_lowercase();
            (encode_dest(&name, false).to_lowercase(), name)
        })
        .collect();
    let mut used = vec![false; candidates.len()];
    // the note itself is already in the trash, so the walk never sees it —
    // and an unreadable root is the same epistemic state as a capped walk:
    // nothing can be proven about what the vault does NOT contain, stand down
    let Ok((others, capped)) = scan_vault_capped(&root.to_string_lossy()) else {
        return Ok(Vec::new());
    };
    if capped {
        // A scan that stopped at a cap is not a list of every note: one past the
        // depth limit may be using this image, and it would be trashed out from
        // under a note still showing it. Same doubt as an unreadable note below,
        // same answer — stand down and take nothing.
        return Err("the vault is too large to rule out other notes using them".into());
    }
    for rel in others {
        let Ok(other) = std::fs::read_to_string(root.join(&rel)) else {
            return Err(format!("“{rel}” couldn't be read to rule its usage out"));
        };
        let other = other.to_lowercase();
        for (i, (encoded, name)) in needles.iter().enumerate() {
            if !used[i] && (other.contains(name.as_str()) || other.contains(encoded.as_str())) {
                used[i] = true;
            }
        }
    }
    Ok(candidates.into_iter().zip(used).filter(|(_, used)| !used).map(|(c, _)| c).collect())
}

fn do_delete_note(path: &str) -> Result<DeleteResult, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err("The note is already gone from the folder.".to_string());
    }
    // Read it before it goes: the note is the only record of which images
    // belonged to it. An unreadable note simply keeps its attachments.
    let vault = vault_root_for(p);
    let note_rel = vault.as_ref().and_then(|root| {
        p.strip_prefix(root).ok().map(|r| r.to_string_lossy().replace('\\', "/"))
    });
    let content = note_rel.as_ref().and_then(|_| std::fs::read_to_string(p).ok());

    trash::delete(p).map_err(|e| format!("Windows couldn't move it to the Recycle Bin. {e}"))?;
    if let Ok(mut map) = known_bytes().lock() {
        map.remove(p);
    }

    let mut trashed = Vec::new();
    let mut sweep_skipped = None;
    match (vault.as_ref(), note_rel.as_ref(), content.as_ref()) {
        (Some(root), Some(rel), Some(content)) => {
            match orphaned_attachments(root, rel, content) {
                Ok(orphans) => {
                    let mut refused: Vec<String> = Vec::new();
                    for att in orphans {
                        let file = root.join(&att);
                        if !file.is_file() {
                            continue;
                        }
                        // to the trash, never removed: an attachment is the
                        // user's file too — and one that refuses to go is an
                        // orphan the user must hear about (s51 #22)
                        match trash::delete(&file) {
                            Ok(()) => trashed.push(att),
                            Err(_) => refused.push(att),
                        }
                    }
                    if !refused.is_empty() {
                        sweep_skipped = Some(format!(
                            "couldn't move to the trash and stayed behind: {}",
                            refused.join(", ")
                        ));
                    }
                }
                Err(why) => sweep_skipped = Some(why),
            }
        }
        // the note refused to be read before it left: the only record of its
        // attachments is gone, so they all stay — say so (s51 #22)
        (Some(_), Some(_), None) => {
            sweep_skipped =
                Some("the note couldn't be read before it left, so they all stay".into());
        }
        _ => {}
    }

    let name = note_name(p);
    let mut paths: Vec<String> = vec![path.to_string()];
    if let Some(root) = vault.as_ref() {
        paths.extend(trashed.iter().map(|t| root.join(t).to_string_lossy().into_owned()));
    }
    let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    let git_error = git_anchor_for(p)
        .and_then(|a| git_commit_paths(&a, &path_refs, &format!("sandy: delete {name}")).err());
    Ok(DeleteResult { trashed, sweep_skipped, git_error })
}

/// Move a note to the system trash (recoverable — never a permanent delete),
/// with the attachments only it was using.
#[tauri::command]
async fn delete_note(path: String) -> Result<DeleteResult, String> {
    tauri::async_runtime::spawn_blocking(move || do_delete_note(&path))
        .await
        .map_err(|e| e.to_string())?
}

/* Resolved against `cwd`, and the RESOLVED path is what's returned (s51 #24):
 * a terminal's `sandy todo.md` used to open the note relative to wherever the
 * process sat — fine at launch, but the single-instance handoff evaluated the
 * SECOND terminal's argv against the FIRST instance's cwd, so the file either
 * never opened (the request vanished into a window-focus) or a same-named
 * file elsewhere opened instead. A relative path also has `parent() == ""`,
 * which the writer refuses — so every save of such a note failed. */
fn markdown_arg(args: &[String], cwd: &Path) -> Option<String> {
    args.iter().skip(1).find_map(|a| {
        let p = Path::new(a);
        let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        let is_note = abs.is_file()
            && matches!(
                abs.extension().and_then(|e| e.to_str()),
                Some(e) if ["md", "markdown", "txt"].iter().any(|x| e.eq_ignore_ascii_case(x))
            );
        is_note.then(|| abs.to_string_lossy().into_owned())
    })
}

/// File passed on the command line at launch (double-clicked .md), if any.
#[tauri::command]
fn initial_file() -> Option<String> {
    // an unreadable cwd degrades to the old behavior: relative args stay
    // relative and simply don't match
    let cwd = std::env::current_dir().unwrap_or_default();
    markdown_arg(&std::env::args().collect::<Vec<_>>(), &cwd)
}

/// Reveal the main window only after the requested document is ready to paint.
#[tauri::command]
fn reveal_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    win.unminimize().map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

/// Force the `.pdf` suffix. The save dialog only *filters* to PDF: a typed
/// `todo.md` comes back unchanged and PrintToPdf would write the export
/// straight over that note. Appended, never substituted — replacing the
/// extension would swallow a dot in an ordinary name ("v1.2 plan").
fn with_pdf_suffix(path: &str) -> String {
    if path.to_lowercase().ends_with(".pdf") {
        path.to_string()
    } else {
        format!("{path}.pdf")
    }
}

/// One-click PDF export: write the hidden `.print-doc` layout straight to a
/// `.pdf` via WebView2 (no print dialog). Windows only; elsewhere the frontend
/// keeps using `window.print()`.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let path = with_pdf_suffix(&path);
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let _ = tx.send(pdf::print_to_pdf(pdf::controller_of(&webview), &path));
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    rx.recv().map_err(|e| format!("pdf result: {e}"))?
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn export_pdf(_path: String) -> Result<(), String> {
    Err("Direct PDF export is available on Windows only.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mirror promise at `WikiIndex`: a raw `[[Note#Heading|alias]]` inner
    /// resolves to the note, exactly as `resolveWikiTarget` does. Both callers
    /// pre-strip today, so nothing else would catch this drifting back.
    #[test]
    fn wiki_resolve_ignores_the_heading_and_alias_tail() {
        let files = vec!["notes/Index.md".to_string()];
        let idx = WikiIndex::build(&files);
        for target in ["Index", "Index#Heading", "Index|alias", "Index#Heading|alias"] {
            assert_eq!(idx.resolve(target), Some("notes/Index.md"), "target {target:?}");
        }
        assert_eq!(idx.resolve("#Heading"), None, "a same-note anchor is not a note");
    }

    #[test]
    fn save_roundtrip_preserves_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.md");
        let path = p.to_str().unwrap();
        let original = "# Test\r\n\r\nline one\r\n- [ ] task\r\nюникод 🌒\r\n";
        do_save_doc(path, original, false).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), original.as_bytes());
        // rename-over-existing path
        let edited = original.replace("line one", "line two");
        do_save_doc(path, &edited, false).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), edited.as_bytes());
    }

    #[test]
    fn a_note_that_wont_open_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone.md");
        let err = do_read_doc(missing.to_str().unwrap()).unwrap_err();
        // deliberately nameless: the App prefix already says which note (s57)
        assert!(err.contains("moved or deleted"), "{err}");
        assert!(!err.contains("os error"), "no machine talk in a shown message: {err}");

        // UTF-16: named by encoding, never decoded — decoding would re-encode
        // the whole file on the first save
        let wide = dir.path().join("wide.md");
        std::fs::write(&wide, [0xFF, 0xFE, b'h', 0x00, b'i', 0x00]).unwrap();
        let err = do_read_doc(wide.to_str().unwrap()).unwrap_err();
        assert!(err.contains("UTF-16LE"), "{err}");
        assert_eq!(
            std::fs::read(&wide).unwrap(),
            [0xFF, 0xFE, b'h', 0x00, b'i', 0x00],
            "a refused read never touches the file"
        );

        // and a plain note still reads, bytes intact
        let ok = dir.path().join("fine.md");
        std::fs::write(&ok, "# Fine\r\nтекст\r\n").unwrap();
        assert_eq!(do_read_doc(ok.to_str().unwrap()).unwrap(), "# Fine\r\nтекст\r\n");
    }

    #[test]
    fn a_note_deleted_underneath_us_is_a_conflict_not_a_recreate() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.md");
        let path = p.to_str().unwrap();
        do_save_doc(path, "mine\n", false).unwrap();

        // deleted in Explorer while the buffer still holds it
        std::fs::remove_file(&p).unwrap();

        let err = do_save_doc(path, "mine, edited\n", false).unwrap_err();
        assert!(err.starts_with(DISK_CONFLICT), "{err}");
        assert!(!p.exists(), "the note must stay deleted, not reappear from the buffer");

        // the user can still say "keep what I wrote"
        do_save_doc(path, "mine, edited\n", true).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"mine, edited\n");
    }

    /// s51 #1: a read that fails for any reason other than "gone" used to skip
    /// both gates and write anyway. A file another writer is holding open is
    /// exactly what gate 2 exists for — and the lock can clear in the
    /// milliseconds before the rename lands, taking the other edit with it.
    #[cfg(windows)]
    #[test]
    fn a_note_we_cannot_read_is_a_conflict_not_an_overwrite() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.md");
        let path = p.to_str().unwrap();
        do_save_doc(path, "mine\n", false).unwrap();

        // a sync client / antivirus / another editor, with every share right denied
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        assert!(std::fs::read(&p).is_err(), "the lock has to actually bite");

        let err = do_save_doc(path, "mine, edited\n", false).unwrap_err();
        assert!(err.starts_with(DISK_CONFLICT), "{err}");
        assert!(!err.contains("os error"), "no machine talk in a shown message: {err}");
        drop(lock);
        assert_eq!(std::fs::read(&p).unwrap(), b"mine\n", "the other writer's file is untouched");

        // a path we have never read still fails open — imports and new notes
        let fresh = dir.path().join("imported.docx.md");
        do_save_doc(fresh.to_str().unwrap(), "new\n", false).unwrap();
    }

    /// s51 #6: `Path::join` throws its base away for an absolute path and
    /// follows "..", so an unvalidated `old_rel` walked the rename out of the
    /// vault — and the git anchor followed it, initialising a repo wherever it
    /// landed. The doc comment promised containment; only the destination had it.
    #[test]
    fn a_rename_cannot_leave_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.md");
        std::fs::write(&outside, "not this vault's note\n").unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        let root = vault.to_str().unwrap();

        for old_rel in [outside.to_str().unwrap(), "../outside.md", "..\\outside.md"] {
            let err = do_rename_note(root, old_rel, "taken").unwrap_err();
            assert!(err.contains("vault"), "{old_rel}: {err}");
        }
        assert!(outside.is_file(), "the file outside the vault is untouched");
        assert!(!dir.path().join(".git").exists(), "and no repo appeared beside it");
    }

    /// s51 #5: the sweep reasons from absence — "no other note mentions this
    /// image". A scan that stopped at its own cap cannot support that sentence,
    /// and the note it never reached is the one still showing the picture.
    #[test]
    fn a_capped_scan_takes_no_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("attachments")).unwrap();
        std::fs::write(root.join("attachments/pic.png"), b"png").unwrap();
        // the note is already in the trash when the sweep runs, so it is only
        // ever its text here
        let content = "![](attachments/pic.png)\n";

        assert_eq!(
            orphaned_attachments(root, "note.md", content),
            Ok(vec!["attachments/pic.png".to_string()]),
            "a complete scan still says the image is orphaned"
        );

        // one folder past the depth cap is all it takes
        let mut deep = root.to_path_buf();
        for i in 0..=SCAN_MAX_DEPTH + 1 {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        assert!(
            orphaned_attachments(root, "note.md", content).is_err(),
            "a truncated walk must stand down, take nothing, and say why (s51 #22)"
        );
    }

    #[test]
    fn identical_save_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.md");
        let path = p.to_str().unwrap();
        do_save_doc(path, "same\r\n", false).unwrap();
        let before = std::fs::metadata(&p).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        do_save_doc(path, "same\r\n", false).unwrap();

        let after = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert_eq!(before, after, "unchanged bytes must not rewrite the file");
        assert_eq!(std::fs::read(&p).unwrap(), b"same\r\n");
    }

    #[test]
    fn save_refuses_to_clobber_an_external_edit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.md");
        let path = p.to_str().unwrap();
        do_save_doc(path, "ours v1\n", false).unwrap();

        // another editor rewrites the file behind our back
        std::fs::write(&p, "theirs\n").unwrap();

        let err = do_save_doc(path, "ours v2\n", false).unwrap_err();
        assert!(err.starts_with(DISK_CONFLICT), "{err}");
        assert_eq!(
            std::fs::read(&p).unwrap(),
            b"theirs\n",
            "disk is the authority — their bytes must survive"
        );

        // an explicit user override is the only way through
        do_save_doc(path, "ours v2\n", true).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"ours v2\n");

        // and the override re-syncs the guard, so normal saves resume
        do_save_doc(path, "ours v3\n", false).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"ours v3\n");
    }

    #[test]
    fn unknown_paths_are_written_normally() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("stranger.md");
        let path = p.to_str().unwrap();
        // a file Sandy never read: the guard must fail open, not block the write
        std::fs::write(&p, "pre-existing\n").unwrap();
        known_bytes().lock().unwrap().remove(&p);

        do_save_doc(path, "written\n", false).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"written\n");
    }

    #[test]
    fn stale_temp_files_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let orphan = dir.path().join(".tmpABC123");
        let innocent = dir.path().join("note.md");
        let named = dir.path().join(".tmpfile-but-longer.md");
        std::fs::write(&orphan, b"crashed mid-save").unwrap();
        std::fs::write(&innocent, b"# real note").unwrap();
        std::fs::write(&named, b"not one of ours").unwrap();

        // age 0 → everything already qualifies as stale
        sweep_temps_older_than(dir.path(), Duration::ZERO);
        assert!(!orphan.exists(), "stale temp removed");
        assert!(innocent.exists(), "real files are never touched");
        assert!(named.exists(), "only tempfile's own .tmpXXXXXX shape is swept");

        // a fresh temp is younger than the cutoff and must survive
        let live = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        sweep_temps_older_than(dir.path(), Duration::from_secs(30));
        assert!(live.path().exists(), "a younger writer's temp is left alone");
    }

    #[test]
    fn autocommit_inits_repo_and_commits_exact_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.md");
        let path = p.to_str().unwrap();
        do_save_doc(path, "v1 line\r\n", false).unwrap();
        do_git_autocommit(path).unwrap();
        assert!(dir.path().join(".git").exists(), "repo auto-initialized");

        do_save_doc(path, "v2 line\r\n", false).unwrap();
        do_git_autocommit(path).unwrap();
        do_git_autocommit(path).unwrap(); // no changes → quietly ok

        let out = run_git(dir.path(), &["log", "--format=%s"]).unwrap();
        let log = String::from_utf8_lossy(&out.stdout).to_string();
        assert_eq!(log.lines().count(), 2, "one commit per change: {log}");
        assert!(log.lines().all(|l| l == "sandy: note.md"), "{log}");

        // history stores exact bytes (CRLF intact in the blob)
        let out = run_git(dir.path(), &["show", "HEAD:note.md"]).unwrap();
        assert_eq!(out.stdout, b"v2 line\r\n");
    }

    #[test]
    fn a_pre_commit_hook_never_rewrites_the_note_being_saved() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        run_git(base, &["init", "-b", "main"]).unwrap();
        let hooks = base.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\nprintf 'hooked\\n' > note.md\n")
            .unwrap();

        let p = base.join("note.md");
        let path = p.to_str().unwrap();

        // control: an ordinary commit proves the hook really fires on this box
        std::fs::write(&p, "control\n").unwrap();
        run_git(base, &["add", "-A"]).unwrap();
        let out = run_git(
            base,
            &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
              "commit", "-m", "control"],
        )
        .unwrap();
        assert_eq!(
            std::fs::read(&p).unwrap(),
            b"hooked\n",
            "the hook never ran, so this repro proves nothing: {}",
            git_said(&out)
        );

        // Sandy's own save + autocommit: the working tree survives it
        do_save_doc(path, "mine\n", false).unwrap();
        do_git_autocommit(path).unwrap();
        assert_eq!(
            std::fs::read(&p).unwrap(),
            b"mine\n",
            "a hook must never rewrite a note mid-save"
        );
        // …and the next save isn't blamed on the user as a disk conflict
        do_save_doc(path, "mine v2\n", false).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"mine v2\n");
    }

    #[test]
    fn a_gitignored_note_says_so_instead_of_failing_forever() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        run_git(base, &["init", "-b", "main"]).unwrap();
        std::fs::write(base.join(".gitignore"), "*.md\n").unwrap();
        let p = base.join("note.md");
        let path = p.to_str().unwrap();
        do_save_doc(path, "text\n", false).unwrap();

        let err = do_git_autocommit(path).unwrap_err();
        assert!(err.contains(".gitignore"), "{err}");
        assert!(!err.contains("hint:"), "one line, in words: {err}");
        // the save itself stands — history is the only thing missing
        assert_eq!(std::fs::read(&p).unwrap(), b"text\n");
    }

    #[test]
    fn a_fresh_vault_gets_one_repo_at_its_root() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("sub/note.md"), "").unwrap();
        do_scan_vault(root); // how the vault root becomes known (the app scans on open)

        let p = base.join("sub/note.md");
        let path = p.to_str().unwrap();
        do_save_doc(path, "hello\n", false).unwrap();
        do_git_autocommit(path).unwrap();
        assert!(base.join(".git").exists(), "history belongs at the vault root");
        assert!(!base.join("sub/.git").exists(), "never a second repo inside the vault");

        // rename anchors the same way, so its commit lands in the same repo
        let res = do_rename_note(root, "sub/note.md", "renamed").unwrap();
        assert_eq!(res.new_rel, "sub/renamed.md");
        assert_eq!(res.git_error, None, "the rename must reach history");
        assert!(!base.join("sub/.git").exists());
        let out = run_git(base, &["log", "--format=%s"]).unwrap();
        let log = String::from_utf8_lossy(&out.stdout).to_string();
        assert_eq!(log.lines().count(), 2, "{log}");
        assert!(log.contains("sandy: rename note -> renamed"), "{log}");
    }

    #[test]
    fn attachment_write_is_binary_exact_and_makes_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("attachments/note-20260718-120000000.png");
        let path = p.to_str().unwrap();
        // not valid UTF-8 — must round-trip as raw bytes
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x00, 0xff, 0xfe, 0x0d, 0x0a];
        do_save_attachment(path, &bytes).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), bytes);

        // copy path: read source, atomic write to dest (nested dir created)
        let src = dir.path().join("shot.png");
        std::fs::write(&src, &bytes).unwrap();
        let dest = dir.path().join("deep/attachments/copy.png");
        let copied = std::fs::read(&src).unwrap();
        do_save_attachment(dest.to_str().unwrap(), &copied).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    }

    #[test]
    fn scan_finds_notes_and_skips_noise() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::create_dir_all(base.join("sub/deep")).unwrap();
        std::fs::create_dir_all(base.join(".obsidian")).unwrap();
        std::fs::create_dir_all(base.join("node_modules/pkg")).unwrap();
        std::fs::write(base.join("B note.md"), "b").unwrap();
        std::fs::write(base.join("a.markdown"), "a").unwrap();
        std::fs::write(base.join("sub/deep/Nested.md"), "n").unwrap();
        std::fs::write(base.join("sub/image.png"), "x").unwrap();
        std::fs::write(base.join(".hidden.md"), "h").unwrap();
        std::fs::write(base.join(".obsidian/config.md"), "c").unwrap();
        std::fs::write(base.join("node_modules/pkg/readme.md"), "r").unwrap();

        let rels = do_scan_vault(base.to_str().unwrap());
        assert_eq!(rels, vec!["a.markdown", "B note.md", "sub/deep/Nested.md"]);
    }

    #[test]
    fn search_is_case_insensitive_and_reports_lines() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::write(base.join("one.md"), "Alpha\r\nsecond LINE here\r\n").unwrap();
        std::fs::write(base.join("two.md"), "nothing\n").unwrap();

        let found = do_search_vault(base.to_str().unwrap(), "line HERE").unwrap();
        assert_eq!(
            found.hits,
            vec![SearchHit { rel: "one.md".into(), line: 2, text: "second LINE here".into() }]
        );
        assert!(!found.truncated, "a short result set is the whole result set");
        assert!(do_search_vault(base.to_str().unwrap(), "  ").unwrap().hits.is_empty());
    }

    #[test]
    fn search_says_when_it_stopped_early() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        // more matches than the cap, spread over two notes
        let many = "needle\n".repeat(SEARCH_MAX_HITS);
        std::fs::write(base.join("a.md"), &many).unwrap();
        std::fs::write(base.join("z.md"), "needle\n").unwrap();

        let found = do_search_vault(base.to_str().unwrap(), "needle").unwrap();
        assert_eq!(found.hits.len(), SEARCH_MAX_HITS);
        assert!(found.truncated, "the walk stopped alphabetically — say so");
        // z.md never got looked at: exactly the silence this flag ends
        assert!(found.hits.iter().all(|h| h.rel == "a.md"));
    }

    #[test]
    fn alias_parsing_covers_yaml_shapes() {
        // inline list + quotes
        assert_eq!(
            parse_frontmatter_aliases("---\naliases: [One, \"Two words\", 'three']\n---\nbody"),
            vec!["One", "Two words", "three"]
        );
        // block list, CRLF, BOM, singular key
        assert_eq!(
            parse_frontmatter_aliases("\u{feff}---\r\nalias:\r\n  - A\r\n  - B\r\n---\r\n"),
            vec!["A", "B"]
        );
        // bare comma string
        assert_eq!(
            parse_frontmatter_aliases("---\ntitle: x\naliases: a, b\n---\n"),
            vec!["a", "b"]
        );
        // no closing fence → not frontmatter; no frontmatter at all; empty list
        assert!(parse_frontmatter_aliases("---\naliases: [x]\nbody").is_empty());
        assert!(parse_frontmatter_aliases("# Just a note\naliases: [x]\n").is_empty());
        assert!(parse_frontmatter_aliases("---\naliases:\ntitle: y\n---\n").is_empty());
    }

    #[test]
    fn scan_aliases_indexes_only_aliased_notes() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::write(base.join("plain.md"), "no frontmatter").unwrap();
        std::fs::write(base.join("named.md"), "---\naliases: [Nick]\n---\ntext").unwrap();

        let idx = do_scan_aliases(base.to_str().unwrap());
        assert_eq!(
            idx,
            vec![NoteAliases { rel: "named.md".into(), aliases: vec!["Nick".into()] }]
        );
    }

    #[test]
    fn scan_aliases_head_read_survives_big_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        // frontmatter within the head window + a body far beyond it
        let big = format!("---\naliases: [Deep]\n---\n{}", "x".repeat(64 * 1024));
        std::fs::write(base.join("big.md"), big).unwrap();

        let idx = do_scan_aliases(base.to_str().unwrap());
        assert_eq!(
            idx,
            vec![NoteAliases { rel: "big.md".into(), aliases: vec!["Deep".into()] }]
        );
    }

    #[test]
    fn create_note_makes_dirs_and_never_clobbers() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("new/sub/note.md");
        let path = p.to_str().unwrap();
        do_create_note(path).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"");

        std::fs::write(&p, "content").unwrap();
        do_create_note(path).unwrap(); // second create: quiet no-op
        assert_eq!(std::fs::read(&p).unwrap(), b"content");
    }

    #[test]
    fn markdown_arg_resolves_against_the_callers_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("todo.md"), "x").unwrap();
        let args: Vec<String> = vec!["sandy.exe".into(), "todo.md".into()];
        let got = markdown_arg(&args, dir.path()).expect("a relative arg must resolve");
        assert_eq!(PathBuf::from(&got), dir.path().join("todo.md"));
        // resolved against the WRONG cwd it must not match — this vanishing
        // silently was s51 #24's single-instance bug
        assert!(markdown_arg(&args, &dir.path().join("elsewhere")).is_none());
    }

    #[test]
    fn new_name_validation_rejects_the_unusable() {
        for bad in [
            "", "a/b", "a\\b", "a?b", "a:b", "con", "LPT3", "dot.", "sp ",
            // s51 #25: the device name is the stem before the first dot
            "CON.md", "NUL.txt", "COM1.notes", "conin$", "CONOUT$.md", "con .md",
        ] {
            assert!(!valid_new_name(bad), "{bad:?} must be rejected");
        }
        for good in ["Note", "My Note 2", "проект-α", "notes.2026", "a.b.c", "Console notes"] {
            assert!(valid_new_name(good), "{good:?} must be accepted");
        }
    }

    /// A rewrite context for one note of a make-believe vault: `files` as it was
    /// before, `old_rel` renamed to `new_rel`, pointed at the note `at`.
    fn rewrite_ctx(files: &[&str], old_rel: &str, new_rel: &str, at: &str) -> Rewrite {
        let before: Vec<String> = files.iter().map(|s| s.to_string()).collect();
        let after: Vec<String> = files
            .iter()
            .map(|s| if *s == old_rel { new_rel.to_string() } else { s.to_string() })
            .collect();
        let mut ctx = Rewrite::new(Path::new(""), &before, &after, old_rel, new_rel);
        ctx.at(at);
        ctx
    }

    #[test]
    fn link_rewrite_covers_wiki_forms_and_preserves_bytes() {
        let doc = "\u{feff}---\r\nrelated: [[Old Note|see]]\r\n---\r\n\
                   Body [[Old Note]] and ![[old note]] and [[Old Note#Part|x]].\r\n\
                   Path [[sub/Old Note]] suffix stays [[Other]].\r\n";
        let ctx =
            rewrite_ctx(&["sub/Old Note.md", "Other.md"], "sub/Old Note.md", "sub/Fresh.md", "n.md");
        let out = rewrite_links(doc, &ctx).unwrap();
        assert_eq!(
            out,
            "\u{feff}---\r\nrelated: [[Fresh|see]]\r\n---\r\n\
             Body [[Fresh]] and ![[Fresh]] and [[Fresh#Part|x]].\r\n\
             Path [[sub/Fresh]] suffix stays [[Other]].\r\n"
        );
        // untouched docs return None, not a rewritten copy
        assert!(rewrite_links("nothing [[Other]] here\n", &ctx).is_none());
    }

    #[test]
    fn link_rewrite_skips_fences_and_inline_code() {
        let doc = "[[Old]] yes\n```md\n[[Old]] fenced\n```\n`[[Old]]` coded, [[Old]] yes\n\
                   ~~~\n[[Old]] fenced too\n~~~\ntail [[Old]]\n";
        let ctx = rewrite_ctx(&["Old.md"], "Old.md", "New.md", "n.md");
        let out = rewrite_links(doc, &ctx).unwrap();
        assert_eq!(
            out,
            "[[New]] yes\n```md\n[[Old]] fenced\n```\n`[[Old]]` coded, [[New]] yes\n\
             ~~~\n[[Old]] fenced too\n~~~\ntail [[New]]\n"
        );
    }

    #[test]
    fn a_bare_link_follows_only_the_note_it_resolved_to() {
        // three per-folder index notes: a bare [[index]] belongs to exactly one
        let files = ["Archive/index.md", "note.md", "Projects/index.md"];
        let doc = "bare [[index]], scoped [[Projects/index]], other [[Archive/index]]\n";

        // renaming the note the bare link did *not* resolve to leaves it alone
        let ctx = rewrite_ctx(&files, "Projects/index.md", "Projects/plan.md", "note.md");
        assert_eq!(
            rewrite_links(doc, &ctx).unwrap(),
            "bare [[index]], scoped [[Projects/plan]], other [[Archive/index]]\n"
        );

        // renaming the one it did resolve to (first in the scan's order) moves it
        let ctx = rewrite_ctx(&files, "Archive/index.md", "Archive/old.md", "note.md");
        assert_eq!(
            rewrite_links(doc, &ctx).unwrap(),
            "bare [[old]], scoped [[Projects/index]], other [[Archive/old]]\n"
        );
    }

    #[test]
    fn a_bare_link_becomes_a_path_when_bare_stops_reaching() {
        // renaming to a stem that already exists elsewhere: bare [[Plan]] would
        // land on Archive/Plan.md, so the link is written as a path instead
        let files = ["Archive/Plan.md", "note.md", "Work/Draft.md"];
        let ctx = rewrite_ctx(&files, "Work/Draft.md", "Work/Plan.md", "note.md");
        assert_eq!(
            rewrite_links("see [[Draft]]\n", &ctx).unwrap(),
            "see [[Work/Plan]]\n"
        );
    }

    #[test]
    fn a_move_carries_path_written_links() {
        let files = ["home.md", "sub/Note.md"];
        let ctx = rewrite_ctx(&files, "sub/Note.md", "moved/deep/Note.md", "home.md");
        // the path form follows; the bare one already resolves and is not touched
        assert_eq!(
            rewrite_links("[[sub/Note]] and [[Note]] and [[sub/Note#h|alias]]\n", &ctx).unwrap(),
            "[[moved/deep/Note]] and [[Note]] and [[moved/deep/Note#h|alias]]\n"
        );
        assert!(rewrite_links("only [[Note]] here\n", &ctx).is_none());
    }

    #[test]
    fn markdown_links_are_rewritten_and_urls_are_not() {
        let files = ["Old Note.md", "note.md"];
        let ctx = rewrite_ctx(&files, "Old Note.md", "New Note.md", "note.md");
        let doc = "[a](Old%20Note.md) [b](<Old Note.md>) [c](Old%20Note.md#part) \
                   [d](https://example.com/Old%20Note.md) [e](#anchor) [f](other.md) \
                   [g](Old%20Note.md \"t\") `[h](Old%20Note.md)`\n";
        assert_eq!(
            rewrite_links(doc, &ctx).unwrap(),
            "[a](New%20Note.md) [b](<New Note.md>) [c](New%20Note.md#part) \
             [d](https://example.com/Old%20Note.md) [e](#anchor) [f](other.md) \
             [g](New%20Note.md \"t\") `[h](Old%20Note.md)`\n"
        );
        // a link from a subfolder walks back up, and stays out of the vault's way
        let ctx = rewrite_ctx(&files, "Old Note.md", "New Note.md", "sub/deep.md");
        assert_eq!(
            rewrite_links("[x](../Old%20Note.md) [y](../../outside.md)\n", &ctx).unwrap(),
            "[x](../New%20Note.md) [y](../../outside.md)\n"
        );
    }

    #[test]
    fn rename_moves_note_rewrites_links_and_refuses_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("sub/Target.md"), "self [[Target]]\r\n").unwrap();
        std::fs::write(base.join("Linker.md"), "see [[target]] and [[sub/Target#h]]\n").unwrap();
        std::fs::write(base.join("sub/Taken.md"), "x").unwrap();

        let res = do_rename_note(root, "sub/Target.md", "Done").unwrap();
        assert_eq!(res.new_rel, "sub/Done.md");
        assert!(res.failed.is_empty());
        assert!(!base.join("sub/Target.md").exists());
        // the renamed note's own self-link and the linker both follow, EOLs kept
        assert_eq!(std::fs::read(base.join("sub/Done.md")).unwrap(), b"self [[Done]]\r\n");
        assert_eq!(
            std::fs::read(base.join("Linker.md")).unwrap(),
            b"see [[Done]] and [[sub/Done#h]]\n"
        );
        assert_eq!(res.rewritten, vec!["Linker.md".to_string(), "sub/Done.md".to_string()]);
        // one commit for the whole operation
        let out = run_git(base, &["log", "--format=%s"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "sandy: rename Target -> Done");

        // an existing name is never clobbered
        let err = do_rename_note(root, "sub/Done.md", "Taken");
        assert!(err.is_err(), "{err:?}");
        // …but changing only the case renames in place without rewrites
        let res = do_rename_note(root, "sub/Done.md", "done").unwrap();
        assert_eq!(res.new_rel, "sub/done.md");
        assert!(res.rewritten.is_empty());
    }

    #[test]
    fn rename_reports_what_it_could_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::write(base.join("Target.md"), "x").unwrap();
        std::fs::write(base.join("linker.md"), "see [[Target]]\n").unwrap();
        // past the search cap: correctness is not allowed to borrow that cap
        let big = format!("[[Target]]\n{}\n", "x".repeat(SEARCH_MAX_FILE_BYTES as usize));
        std::fs::write(base.join("big.md"), &big).unwrap();
        // …and a note that isn't text at all
        std::fs::write(base.join("wide.md"), [0xFF, 0xFE, b'h', 0x00]).unwrap();

        let res = do_rename_note(root, "Target.md", "Renamed").unwrap();
        assert!(res.failed.is_empty(), "{res:?}");
        assert!(res.rewritten.contains(&"linker.md".to_string()), "{res:?}");
        assert!(res.rewritten.contains(&"big.md".to_string()), "the size cap is gone: {res:?}");
        assert!(std::fs::read_to_string(base.join("big.md"))
            .unwrap()
            .starts_with("[[Renamed]]"));
        assert_eq!(
            res.skipped,
            vec![SkippedFile { rel: "wide.md".into(), reason: "not UTF-8 text".into() }]
        );
        assert_eq!(res.scanned, 4, "every note the walk looked at is counted");
    }

    #[test]
    fn a_case_only_rename_never_replaces_a_different_file() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::write(base.join("Note.md"), "mine\n").unwrap();
        let other = base.join("Other.md");
        std::fs::write(&other, "theirs\n").unwrap();

        // Only the filesystem knows whether the target is this note under
        // another casing or a second note fs::rename would replace outright.
        assert!(!is_same_file(&base.join("Note.md"), &other));
        #[cfg(windows)]
        assert!(
            is_same_file(&base.join("Note.md"), &base.join("note.md")),
            "on a case-insensitive volume these are one file"
        );

        assert!(do_rename_note(root, "Note.md", "Other").is_err());
        assert_eq!(std::fs::read(&other).unwrap(), b"theirs\n", "the other note survives");
        // …while the in-place case flip still goes through
        let res = do_rename_note(root, "Note.md", "note").unwrap();
        assert_eq!(res.new_rel, "note.md");
        assert_eq!(std::fs::read(base.join("note.md")).unwrap(), b"mine\n");
    }

    #[test]
    fn pdf_export_forces_its_own_suffix() {
        // the dialog filters to .pdf, but a typed name comes back as typed
        assert_eq!(with_pdf_suffix("C:/notes/todo.md"), "C:/notes/todo.md.pdf");
        assert_eq!(with_pdf_suffix("C:/notes/todo"), "C:/notes/todo.pdf");
        assert_eq!(with_pdf_suffix("C:/notes/todo.pdf"), "C:/notes/todo.pdf");
        assert_eq!(with_pdf_suffix("C:/notes/TODO.PDF"), "C:/notes/TODO.PDF");
        // never substitute: an ordinary dot is not an extension
        assert_eq!(with_pdf_suffix("C:/v1.2 plan.md"), "C:/v1.2 plan.md.pdf");
    }

    #[test]
    fn delete_removes_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("gone.md");
        std::fs::write(&p, "bye").unwrap();
        do_delete_note(p.to_str().unwrap()).unwrap();
        assert!(!p.exists(), "note must leave the folder (to the system trash)");
        assert!(do_delete_note(p.to_str().unwrap()).is_err(), "double delete reports");
    }

    #[test]
    fn a_note_can_move_into_a_folder_and_take_its_links_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::create_dir_all(base.join("old/attachments")).unwrap();
        std::fs::write(base.join("old/attachments/shot.png"), b"png").unwrap();
        std::fs::write(
            base.join("old/Note.md"),
            "\u{feff}![shot](attachments/shot.png)\r\nup [[Home]]\r\n",
        )
        .unwrap();
        std::fs::write(
            base.join("Home.md"),
            "see [[old/Note]], bare [[Note]], md [a](old/Note.md)\n",
        )
        .unwrap();

        let res = do_rename_note(root, "old/Note.md", "new/deep/Note").unwrap();
        assert_eq!(res.new_rel, "new/deep/Note.md");
        assert!(res.failed.is_empty() && res.skipped.is_empty(), "{res:?}");
        assert!(base.join("new/deep/Note.md").is_file(), "the folder is created on the way");
        assert!(!base.join("old/Note.md").exists());

        // links written as a path follow; the bare one already resolves
        assert_eq!(
            std::fs::read_to_string(base.join("Home.md")).unwrap(),
            "see [[new/deep/Note]], bare [[Note]], md [a](new/deep/Note.md)\n"
        );
        // the moved note keeps pointing at its own image, from further away —
        // BOM and CRLF exactly as they were
        assert_eq!(
            std::fs::read(base.join("new/deep/Note.md")).unwrap(),
            "\u{feff}![shot](../../old/attachments/shot.png)\r\nup [[Home]]\r\n".as_bytes()
        );
    }

    #[test]
    fn a_move_never_leaves_the_vault_or_lands_on_a_note() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("Note.md"), "mine\n").unwrap();
        std::fs::write(base.join("sub/Taken.md"), "theirs\n").unwrap();

        for bad in ["../escape", "..\\escape", "sub/../../escape", "C:/tmp/escape", "sub/con"] {
            let err = do_rename_note(root, "Note.md", bad);
            assert!(err.is_err(), "{bad:?} must be refused: {err:?}");
        }
        let err = do_rename_note(root, "Note.md", "sub/Taken").unwrap_err();
        assert!(err.contains("already exists"), "{err}");

        assert_eq!(std::fs::read(base.join("Note.md")).unwrap(), b"mine\n", "nothing moved");
        assert_eq!(std::fs::read(base.join("sub/Taken.md")).unwrap(), b"theirs\n");
        assert!(!base.parent().unwrap().join("escape.md").exists());
    }

    #[test]
    fn crlf_and_bom_survive_a_rename_a_move_and_a_delete() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::create_dir_all(base.join("sub")).unwrap();
        // a BOM'd CRLF note that links to the note about to move
        let linker = "\u{feff}# Log\r\n\r\nsee [[Target]] and [x](Target.md)\r\nтекст 🌒\r\n";
        std::fs::write(base.join("Linker.md"), linker).unwrap();
        // …and one that mentions nothing: not one byte of it may move
        let bystander = "\u{feff}nothing here\r\n\r\n- [ ] task\r\n";
        std::fs::write(base.join("sub/Bystander.md"), bystander).unwrap();
        std::fs::write(base.join("Target.md"), "\u{feff}body\r\n").unwrap();

        do_rename_note(root, "Target.md", "Renamed").unwrap();
        assert_eq!(
            std::fs::read(base.join("Linker.md")).unwrap(),
            "\u{feff}# Log\r\n\r\nsee [[Renamed]] and [x](Renamed.md)\r\nтекст 🌒\r\n".as_bytes()
        );
        assert_eq!(std::fs::read(base.join("Renamed.md")).unwrap(), "\u{feff}body\r\n".as_bytes());

        do_rename_note(root, "Renamed.md", "sub/Renamed").unwrap();
        assert_eq!(
            std::fs::read(base.join("Linker.md")).unwrap(),
            "\u{feff}# Log\r\n\r\nsee [[Renamed]] and [x](sub/Renamed.md)\r\nтекст 🌒\r\n"
                .as_bytes()
        );
        assert_eq!(
            std::fs::read(base.join("sub/Renamed.md")).unwrap(),
            "\u{feff}body\r\n".as_bytes()
        );

        do_delete_note(base.join("sub/Renamed.md").to_str().unwrap()).unwrap();
        assert_eq!(
            std::fs::read(base.join("sub/Bystander.md")).unwrap(),
            bystander.as_bytes(),
            "a note nothing pointed at is never rewritten"
        );
    }

    #[test]
    fn an_exclusive_attachment_leaves_with_its_note_and_a_shared_one_stays() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let root = base.to_str().unwrap();
        std::fs::create_dir_all(base.join("attachments")).unwrap();
        std::fs::write(base.join("attachments/only-mine.png"), b"a").unwrap();
        std::fs::write(base.join("attachments/shared.png"), b"b").unwrap();
        std::fs::write(base.join("attachments/nobodys.png"), b"c").unwrap();
        std::fs::write(
            base.join("Note.md"),
            "![](attachments/only-mine.png)\n![](attachments/shared.png)\n\
             ```\n![](attachments/nobodys.png)\n```\n",
        )
        .unwrap();
        std::fs::write(base.join("Other.md"), "also ![](attachments/shared.png)\n").unwrap();
        do_scan_vault(root); // how the vault root becomes known

        let res = do_delete_note(base.join("Note.md").to_str().unwrap()).unwrap();
        assert_eq!(res.trashed, vec!["attachments/only-mine.png".to_string()]);
        assert!(!base.join("attachments/only-mine.png").exists());
        assert!(
            base.join("attachments/shared.png").is_file(),
            "an image another note uses is never taken"
        );
        assert!(
            base.join("attachments/nobodys.png").is_file(),
            "a path inside a code fence is an example, not a use"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            use tauri::{Emitter, Manager};
            // the second instance's OWN cwd — the plugin supplies it for
            // exactly this; evaluating argv against our cwd opened the wrong
            // file or none (s51 #24)
            if let Some(file) = markdown_arg(&argv, Path::new(&cwd)) {
                let _ = app.emit("sandy://open-file", file);
            } else if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // An undecorated window opts out of Win11's rounded corners; this
            // asks DWM for them back. Best-effort — on Win10 or a refusal the
            // window is exactly what it was (imba-roadmap §W1.10).
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use windows::Win32::Graphics::Dwm::{
                    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                    DWMWCP_ROUND, DWM_WINDOW_CORNER_PREFERENCE,
                };
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(hwnd) = win.hwnd() {
                        let pref: DWM_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND;
                        unsafe {
                            let _ = DwmSetWindowAttribute(
                                windows::Win32::Foundation::HWND(hwnd.0),
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &pref as *const _ as *const std::ffi::c_void,
                                std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                            );
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_doc,
            file_exists,
            save_doc,
            save_attachment,
            copy_attachment,
            git_autocommit,
            initial_file,
            reveal_main_window,
            scan_vault,
            search_vault,
            scan_aliases,
            create_note,
            rename_note,
            delete_note,
            convert::convert_file_to_markdown,
            export_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
