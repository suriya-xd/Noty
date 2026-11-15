import type { VaultEntry } from "../types/noetic";

/** The folder, at the top of the notes folder, where images added to notes are saved. */
export const ASSETS_FOLDER = "assets";

/** True for the assets folder itself and everything inside it. */
export function isAssetPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  return p === ASSETS_FOLDER || p.startsWith(`${ASSETS_FOLDER}/`);
}

/** The entries shown in the notes list: everything except the assets folder (see Settings). */
export function withoutAssets(entries: VaultEntry[]): VaultEntry[] {
  return entries.filter((e) => !isAssetPath(e.path));
}

/** The uploaded files (not folders) in the assets folder, newest first. */
export function assetFiles(entries: VaultEntry[]): VaultEntry[] {
  return entries
    .filter((e) => !e.is_directory && isAssetPath(e.path))
    .sort((a, b) => b.modified_ms - a.modified_ms || a.path.localeCompare(b.path));
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
export const isImagePath = (path: string) => IMAGE_EXT.test(path);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
