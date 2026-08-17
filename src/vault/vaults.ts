/*
 * Known-vaults persistence: folders the user explicitly opened as vaults.
 * localStorage only — UI state, never file content. Auto-followed roots
 * (parent dir of a lone opened file) are deliberately NOT recorded here;
 * the list holds only deliberate choices. Defensive reads, like session.ts.
 */
import { samePath } from "./vault";

const VAULTS_KEY = "sandy:vaults";
const ACTIVE_VAULT_KEY = "sandy:vault";
const VAULTS_MAX = 8;

export function loadKnownVaults(): string[] {
  try {
    const raw = localStorage.getItem(VAULTS_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .slice(0, VAULTS_MAX);
  } catch {
    return [];
  }
}

/** Move `root` to the head (dedup like recents); returns the new list. */
export function pushKnownVault(root: string): string[] {
  const next = [root, ...loadKnownVaults().filter((p) => !samePath(p, root))].slice(
    0,
    VAULTS_MAX,
  );
  try {
    localStorage.setItem(VAULTS_KEY, JSON.stringify(next));
  } catch {
    // non-fatal; the in-memory list still updates for this session
  }
  return next;
}

export function removeKnownVault(root: string): string[] {
  const next = loadKnownVaults().filter((p) => !samePath(p, root));
  try {
    localStorage.setItem(VAULTS_KEY, JSON.stringify(next));
  } catch {
    // non-fatal
  }
  return next;
}

/** The vault to restore on launch (may be an auto-followed root). */
export function loadActiveVault(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_VAULT_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function saveActiveVault(root: string | null): void {
  try {
    if (root) localStorage.setItem(ACTIVE_VAULT_KEY, root);
    else localStorage.removeItem(ACTIVE_VAULT_KEY);
  } catch {
    // non-fatal
  }
}
