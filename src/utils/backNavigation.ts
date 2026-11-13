import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Android back button (and gesture) support for the mobile layout.
 *
 * On Android, Back makes the app's WebView go back in its browser history, and closes the app
 * when there is no history left. The app is a single page that never added history, so Back
 * always closed it. Here every screen, note, sheet or dialog that should be closed by Back adds
 * one history entry while it is open; Back then removes the newest entry, the browser reports it
 * (`popstate`), and the screen that owns it closes. With everything closed there are no entries
 * left, so Back at the dashboard leaves the app as Android normally does.
 *
 * Entries carry no data: only their number matters, kept equal to the number of open screens.
 * A screen closed some other way (its own close button) takes its entry back off the history.
 */

interface Entry {
  id: number;
  onBack: () => void;
}

const stack: Entry[] = [];
let nextId = 1;
let enabledBy = 0;
let listening = false;
/** `popstate` events caused by our own history.go() calls, which aren't Back presses. */
let ownPops = 0;
/** Entries to take off the history in the next go(), batched so several closes are one step. */
let pendingRemovals = 0;

function onPopState() {
  if (ownPops > 0) {
    ownPops--;
    return;
  }
  stack.pop()?.onBack();
}

function flushRemovals() {
  const count = pendingRemovals;
  pendingRemovals = 0;
  if (count > 0) {
    ownPops++;
    history.go(-count);
  }
}

/**
 * Turns back handling on for as long as the returned function isn't called. Only the mobile
 * layout does this; elsewhere the functions below do nothing, so desktop history is untouched.
 */
export function enableBackNavigation(): () => void {
  enabledBy++;
  if (!listening) {
    window.addEventListener("popstate", onPopState);
    listening = true;
  }
  return () => {
    enabledBy--;
  };
}

/**
 * Adds a history entry that Back will use to call `onBack`. Returns a function that removes the
 * entry again, for when the screen closes another way; it does nothing once Back has used it.
 */
export function pushBackEntry(onBack: () => void): () => void {
  if (enabledBy === 0) return () => {};
  const id = nextId++;
  stack.push({ id, onBack });
  history.pushState({ noeticBack: id }, "");
  return () => {
    const index = stack.findIndex((e) => e.id === id);
    if (index === -1) return;
    stack.splice(index, 1);
    pendingRemovals++;
    if (pendingRemovals === 1) queueMicrotask(flushRemovals);
  };
}

/** Does what the device's Back would do: closes the newest open screen, if any. */
export function goBack(): boolean {
  if (enabledBy === 0 || stack.length === 0) return false;
  history.back();
  return true;
}

/** Turns back handling on while the calling component is mounted. */
export function useBackNavigation() {
  // A layout effect, so it is on before any screen's (passive) effect adds an entry.
  useLayoutEffect(() => enableBackNavigation(), []);
}

/** While `active`, Back calls `onBack` (which should make `active` false). */
export function useBackLayer(active: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    return pushBackEntry(() => onBackRef.current());
  }, [active]);
}
