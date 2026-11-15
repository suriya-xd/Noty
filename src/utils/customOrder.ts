// Custom sorting and ordering utilities for Noetic files and folders

export type CustomOrderMap = Record<string, string[]>; // parentPath -> array of child names

export type SortMode = "custom" | "alpha-asc" | "alpha-desc";

const STORAGE_KEY_PREFIX = "noetic_custom_order_";
const SORT_MODE_KEY_PREFIX = "noetic_sort_mode_";

/**
 * Load custom order map from localStorage for a specific vault
 */
export function getStoredCustomOrder(vaultPath: string): CustomOrderMap {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${vaultPath || "default"}`);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to load custom order:", e);
  }
  return {};
}

const orderListeners = new Set<() => void>();

/** Calls `listener` whenever a custom order is saved, so views can reload it. Returns an unsubscribe. */
export function subscribeCustomOrder(listener: () => void): () => void {
  orderListeners.add(listener);
  return () => {
    orderListeners.delete(listener);
  };
}

/**
 * Save custom order map to localStorage
 */
export function saveCustomOrder(vaultPath: string, order: CustomOrderMap): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${vaultPath || "default"}`, JSON.stringify(order));
  } catch (e) {
    console.warn("Failed to save custom order:", e);
  }
  orderListeners.forEach((listener) => listener());
}

/**
 * Load sort mode preference (default: "custom")
 */
export function getStoredSortMode(vaultPath: string): SortMode {
  try {
    const mode = localStorage.getItem(`${SORT_MODE_KEY_PREFIX}${vaultPath || "default"}`) as SortMode;
    if (mode === "alpha-asc" || mode === "alpha-desc" || mode === "custom") return mode;
  } catch {}
  return "custom";
}

/**
 * Save sort mode preference
 */
export function saveSortMode(vaultPath: string, mode: SortMode): void {
  try {
    localStorage.setItem(`${SORT_MODE_KEY_PREFIX}${vaultPath || "default"}`, mode);
  } catch {}
}

/**
 * Extracts parent directory from a path ("" for root, "Projects" for "Projects/Notes.md")
 */
export function getParentPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  return norm.includes("/") ? norm.substring(0, norm.lastIndexOf("/")) : "";
}

/**
 * Extracts base name from a path ("Notes.md" for "Projects/Notes.md")
 */
export function getItemName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  return norm.split("/").pop() || "";
}

/**
 * Reorders an item within a parent hierarchy before or after a target sibling.
 */
export function reorderItem(
  currentOrder: CustomOrderMap,
  parentPath: string,
  allSiblingNames: string[],
  movedName: string,
  targetName: string,
  position: "before" | "after"
): CustomOrderMap {
  // Start with existing order or initialize with current siblings
  let list = currentOrder[parentPath] ? [...currentOrder[parentPath]] : [...allSiblingNames];

  // Ensure all current siblings are in the list
  for (const name of allSiblingNames) {
    if (!list.includes(name)) list.push(name);
  }
  // Filter out any stale items that no longer exist
  list = list.filter((name) => allSiblingNames.includes(name) || name === movedName);

  // Remove moved item from list
  list = list.filter((n) => n !== movedName);

  // Find target index
  const targetIndex = list.indexOf(targetName);
  if (targetIndex === -1) {
    if (position === "before") list.unshift(movedName);
    else list.push(movedName);
  } else {
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    list.splice(insertIndex, 0, movedName);
  }

  return {
    ...currentOrder,
    [parentPath]: list,
  };
}

/**
 * Moves an item one step up or down relative to its siblings.
 */
export function moveItemStep(
  currentOrder: CustomOrderMap,
  parentPath: string,
  allSiblingNames: string[],
  itemName: string,
  direction: "up" | "down"
): CustomOrderMap {
  let list = currentOrder[parentPath] ? [...currentOrder[parentPath]] : [...allSiblingNames];

  for (const name of allSiblingNames) {
    if (!list.includes(name)) list.push(name);
  }
  list = list.filter((name) => allSiblingNames.includes(name));

  const idx = list.indexOf(itemName);
  if (idx === -1) return currentOrder;

  const newIdx = direction === "up" ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= list.length) return currentOrder; // Already at boundary

  // Swap positions
  const temp = list[idx];
  list[idx] = list[newIdx];
  list[newIdx] = temp;

  return {
    ...currentOrder,
    [parentPath]: list,
  };
}

/**
 * Handles path renaming inside the custom order map. A renamed or moved folder takes the saved
 * order of everything inside it along, so its contents keep their arrangement.
 */
export function renameInCustomOrder(
  currentOrder: CustomOrderMap,
  oldPath: string,
  newPath: string
): CustomOrderMap {
  const oldParent = getParentPath(oldPath);
  const newParent = getParentPath(newPath);
  const oldName = getItemName(oldPath);
  const newName = getItemName(newPath);

  const updated: CustomOrderMap = {};
  // Re-key the folder's own order and that of every folder inside it.
  for (const [key, list] of Object.entries(currentOrder)) {
    if (key === oldPath) updated[newPath] = list;
    else if (key.startsWith(oldPath + "/")) updated[newPath + key.slice(oldPath.length)] = list;
    else updated[key] = list;
  }

  if (oldParent === newParent) {
    if (updated[oldParent]) {
      updated[oldParent] = updated[oldParent].map((n) => (n === oldName ? newName : n));
    }
  } else {
    // Moved across folders
    if (updated[oldParent]) {
      updated[oldParent] = updated[oldParent].filter((n) => n !== oldName);
    }
    if (updated[newParent]) {
      if (!updated[newParent].includes(newName)) {
        updated[newParent] = [...updated[newParent], newName];
      }
    }
  }

  return updated;
}

export type DropPosition = "before" | "after" | "inside";

/**
 * Whether `source` can be dropped at `target`. Nothing can be dropped on itself, and a folder
 * can't go inside itself or anything it contains. Only folders take an "inside" drop.
 */
export function canDrop(source: string, target: string, position: DropPosition, targetIsDir: boolean): boolean {
  if (!source || source === target) return false;
  if (target.startsWith(source + "/")) return false;
  if (position === "inside" && !targetIsDir) return false;
  return true;
}

export interface DropPlan {
  /** Where the dragged item ends up; equal to the source when it only changes order. */
  newPath: string;
  /** The custom order with the item in its new place. */
  order: CustomOrderMap;
}

/**
 * Works out a drag-and-drop in the notes tree. `target` is "" with "inside" for the top level.
 *
 * `siblingNames` is the on-screen order of the target's siblings (for before/after), and
 * `childNames` the on-screen order of the folder's contents (for inside). When the list isn't in
 * custom order (`fromScreen`), the arrangement on screen becomes the starting point, so dropping
 * one item doesn't shuffle the rest.
 */
export function planDrop(
  order: CustomOrderMap,
  drop: {
    source: string;
    target: string;
    position: DropPosition;
    siblingNames: string[];
    childNames: string[];
    fromScreen: boolean;
  }
): DropPlan {
  const { source, target, position, siblingNames, childNames, fromScreen } = drop;
  const name = getItemName(source);
  const dest = position === "inside" ? target : getParentPath(target);
  const newPath = dest ? `${dest}/${name}` : name;

  let next = newPath === source ? { ...order } : renameInCustomOrder(order, source, newPath);

  if (position === "inside") {
    const base = fromScreen || !next[dest] ? childNames : next[dest];
    next[dest] = [...base.filter((n) => n !== name), name];
    return { newPath, order: next };
  }

  const names = Array.from(new Set([...siblingNames, name]));
  if (fromScreen || !next[dest]) next = { ...next, [dest]: siblingNames.filter((n) => n !== name) };
  next = reorderItem(next, dest, names, name, getItemName(target), position);
  return { newPath, order: next };
}

/**
 * Recursively sorts tree nodes according to sortMode and customOrder
 */
export function sortTreeNodes<T extends { name: string; isDirectory: boolean; children: T[] }>(
  nodes: T[],
  parentPath: string,
  sortMode: SortMode,
  customOrder: CustomOrderMap
): T[] {
  const result = [...nodes];

  if (sortMode === "alpha-asc") {
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  } else if (sortMode === "alpha-desc") {
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" });
    });
  } else {
    // Custom sort mode
    const orderList = customOrder[parentPath] || [];

    result.sort((a, b) => {
      const idxA = orderList.indexOf(a.name);
      const idxB = orderList.indexOf(b.name);

      if (idxA !== -1 && idxB !== -1) {
        return idxA - idxB;
      }
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;

      // Fallback if neither is ranked: directories first, then alphabetical
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  // Recursively sort children
  for (const node of result) {
    if (node.children && node.children.length > 0) {
      const childParent = parentPath ? `${parentPath}/${node.name}` : node.name;
      node.children = sortTreeNodes(node.children, childParent, sortMode, customOrder);
    }
  }

  return result;
}
