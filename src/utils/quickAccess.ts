import { useSyncExternalStore } from "react";

/**
 * Pinned and recently opened notes, canvases and folders, shown on the dashboard.
 *
 * Kept on this device (localStorage), separately for each workspace: workspaces share one notes
 * folder, and the same path can exist in two of them.
 */

export interface QuickItem {
  path: string;
  isFolder: boolean;
}
export interface RecentItem extends QuickItem {
  /** When it was last opened (ms since epoch). */
  at: number;
}
export interface QuickAccess {
  pins: QuickItem[];
  recent: RecentItem[];
}

const KEY_PREFIX = "noetic.quickAccess.";
const MAX_RECENT = 20;
const EMPTY: QuickAccess = { pins: [], recent: [] };

let scope = "";
let state: QuickAccess = EMPTY;
const listeners = new Set<() => void>();

function load(key: string): QuickAccess {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<QuickAccess>;
    return {
      pins: Array.isArray(parsed.pins) ? parsed.pins.filter((p) => typeof p?.path === "string") : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((r) => typeof r?.path === "string") : [],
    };
  } catch {
    return EMPTY;
  }
}

function commit(next: QuickAccess) {
  state = next;
  try {
    localStorage.setItem(KEY_PREFIX + scope, JSON.stringify(next));
  } catch {
    // Not saved (private mode, storage full): it still works until the app closes.
  }
  listeners.forEach((l) => l());
}

/** Selects the workspace whose pins and recent items are read and written. */
export function setQuickAccessScope(vaultPath: string, workspace: string) {
  const next = `${vaultPath || "default"}::${workspace}`;
  if (next === scope) return;
  scope = next;
  state = load(next);
  listeners.forEach((l) => l());
}

export function subscribeQuickAccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getQuickAccess = (): QuickAccess => state;

export function useQuickAccess(): QuickAccess {
  return useSyncExternalStore(subscribeQuickAccess, getQuickAccess);
}

export const isPinned = (path: string) => state.pins.some((p) => p.path === path);

/** Pins an item (to the end of the pinned list), or unpins it if it is pinned. */
export function togglePin(path: string, isFolder: boolean) {
  commit({
    ...state,
    pins: isPinned(path) ? state.pins.filter((p) => p.path !== path) : [...state.pins, { path, isFolder }],
  });
}

/** Notes that a note, canvas or folder was just opened. */
export function recordOpened(path: string, isFolder: boolean, now = Date.now()) {
  if (!path) return;
  commit({
    ...state,
    recent: [{ path, isFolder, at: now }, ...state.recent.filter((r) => r.path !== path)].slice(0, MAX_RECENT),
  });
}

/** Follows a rename or move; a folder's contents move with it. */
export function renameInQuickAccess(oldPath: string, newPath: string) {
  const moved = (p: string) =>
    p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;
  if (![...state.pins, ...state.recent].some((i) => moved(i.path) !== i.path)) return;
  commit({
    pins: state.pins.map((p) => ({ ...p, path: moved(p.path) })),
    recent: state.recent.map((r) => ({ ...r, path: moved(r.path) })),
  });
}

/** Forgets a deleted item (and, for a folder, everything in it). */
export function removeFromQuickAccess(path: string) {
  const gone = (p: string) => p === path || p.startsWith(path + "/");
  if (![...state.pins, ...state.recent].some((i) => gone(i.path))) return;
  commit({ pins: state.pins.filter((p) => !gone(p.path)), recent: state.recent.filter((r) => !gone(r.path)) });
}

/**
 * What the dashboard shows: the pins, or when nothing is pinned, the most recently opened items.
 * Items whose file or folder no longer exists (deleted elsewhere, or synced away) are left out.
 */
export function dashboardItems(
  qa: QuickAccess,
  existing: ReadonlyMap<string, boolean>,
  limit = 8
): { kind: "pinned" | "recent"; items: (QuickItem & { at?: number })[] } {
  const present = <T extends QuickItem>(i: T) => existing.get(i.path) === i.isFolder;
  const pins = qa.pins.filter(present);
  if (pins.length) return { kind: "pinned", items: pins };
  return { kind: "recent", items: qa.recent.filter(present).slice(0, limit) };
}

/** Cross-component request to show a folder in the desktop sidebar (opened and scrolled to). */
const revealListeners = new Set<(path: string) => void>();
export function revealInSidebar(path: string) {
  revealListeners.forEach((l) => l(path));
}
export function onRevealInSidebar(listener: (path: string) => void): () => void {
  revealListeners.add(listener);
  return () => revealListeners.delete(listener);
}
