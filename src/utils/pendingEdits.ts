/**
 * Editors write to disk a moment after typing stops. Each open editor registers how to write what
 * is pending right now, so a save or sync always starts from what is on screen.
 */
type Flush = () => Promise<void> | void;

const flushers = new Set<Flush>();

export function registerPendingEdits(flush: Flush): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

export async function flushPendingEdits(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush()));
}
