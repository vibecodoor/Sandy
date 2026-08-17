/*
 * Save orchestration: single-flight, latest-wins per path, FIFO across paths,
 * failure surfacing with automatic retry. Framework-free; the actual writer is
 * injected (src/vault/files.ts::saveDoc in the app, a fake in tests).
 *
 * Data-path rule: this module decides only WHEN the
 * writer runs — text and eol pass through byte-untouched, and the atomic
 * writer itself (src-tauri lib.rs) stays quarantined.
 */
import { type Eol, type SaveResult, isDiskConflict } from "./files";

export interface SaveRequest {
  path: string;
  text: string;
  eol: Eol;
}

export interface SaveStatus {
  /** Unsaved changes exist (queued or being written). */
  dirty: boolean;
  /**
   * Last write failure; cleared by the next successful save of that path.
   * `conflict` means the file changed on disk: retrying can never succeed, so
   * the queue stops and waits for the user to pick a side.
   */
  failure: { path: string; message: string; conflict: boolean } | null;
}

/* Resolving is success: the bytes are on disk. The result only carries what
 * happened *after* that — today, whether the history commit went through. */
type Writer = (
  path: string,
  text: string,
  eol: Eol,
  force: boolean,
) => Promise<SaveResult>;

const RETRY_MS = 5000;

export class SaveQueue {
  onStatus: ((status: SaveStatus) => void) | null = null;
  /**
   * The save landed, its history commit didn't. Fired at most once per session:
   * whatever stops git working stops it for every later save too, and the same
   * strip repeating every 800 ms would be noise, not news.
   */
  onGitError: ((message: string) => void) | null = null;

  private queue: SaveRequest[] = [];
  private inflight = false;
  private failure: SaveStatus["failure"] = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<(ok: boolean) => void> = [];
  private writer: Writer;
  /** Armed by overwrite() to the conflicted path; consumed only by that path's write. */
  private forcePath: string | null = null;
  private gitReported = false;

  constructor(writer: Writer) {
    this.writer = writer;
  }

  status(): SaveStatus {
    return { dirty: this.queue.length > 0 || this.inflight, failure: this.failure };
  }

  /** Enqueue the newest text for a path; a queued save of the same path is replaced. */
  request(req: SaveRequest): void {
    const last = this.queue[this.queue.length - 1];
    if (last && last.path === req.path) this.queue[this.queue.length - 1] = req;
    else this.queue.push(req);
    this.emit();
    void this.pump();
  }

  /**
   * Throw away everything queued for a path and forget its failure. The edits
   * are gone — only for the user explicitly choosing the version on disk.
   */
  discard(path: string): void {
    this.queue = this.queue.filter((r) => r.path !== path);
    if (this.failure?.path === path) this.failure = null;
    if (this.forcePath === path) this.forcePath = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.emit();
  }

  /**
   * Resolve a disk conflict by overwriting the other version. Only ever called
   * from an explicit user choice — the automatic retry path never forces.
   */
  overwrite(): Promise<boolean> {
    // Force only the conflicted path: another path's save queued ahead must
    // not consume the flag and land as a silent overwrite of the wrong file.
    this.forcePath = this.failure?.path ?? null;
    return this.flush();
  }

  /** Drive the queue to empty. Resolves true once everything is on disk. */
  flush(): Promise<boolean> {
    if (this.queue.length === 0 && !this.inflight) {
      return Promise.resolve(this.failure === null);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const done = new Promise<boolean>((resolve) => this.waiters.push(resolve));
    void this.pump();
    return done;
  }

  private emit(): void {
    this.onStatus?.(this.status());
  }

  private settle(ok: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(ok);
  }

  private async pump(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      while (this.queue.length) {
        const req = this.queue[0];
        const force = this.forcePath != null && req.path === this.forcePath;
        if (force) this.forcePath = null;
        try {
          const result = await this.writer(req.path, req.text, req.eol, force);
          // Success: drop the request unless newer text already replaced it.
          if (this.queue[0] === req) this.queue.shift();
          if (this.failure?.path === req.path) this.failure = null;
          if (result.gitError && !this.gitReported) {
            this.gitReported = true;
            this.onGitError?.(result.gitError);
          }
          this.emit();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const conflict = isDiskConflict(message);
          this.failure = { path: req.path, message, conflict };
          this.emit();
          // Keep the request at head. A conflict is not retryable — retrying
          // would only refuse again — so the queue idles until the user chooses.
          if (!conflict) {
            this.retryTimer ??= setTimeout(() => {
              this.retryTimer = null;
              void this.pump();
            }, RETRY_MS);
          }
          this.settle(false);
          return;
        }
      }
      this.settle(true);
    } finally {
      this.inflight = false;
      this.emit();
      // Belt: a request that landed while waiters were settling still pumps.
      // Never while a conflict is unresolved — that would spin refusing forever.
      if (this.queue.length && !this.retryTimer && !this.failure?.conflict) {
        void this.pump();
      }
    }
  }
}
