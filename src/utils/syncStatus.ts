import type { RepoStatusPayload } from "../types/noetic";

/** Why the last sync didn't get through, and since when. */
export interface SyncProblem {
  kind: "offline" | "sign-in" | "other";
  message: string;
  since: number;
}

export type SyncKind = "signed-out" | "sign-in" | "conflict" | "offline" | "waiting" | "updates" | "synced";

export interface SyncDescription {
  kind: SyncKind;
  label: string;
  headline: string;
  detail: string;
}

const DAY = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "noetic_sync_problem";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `signInRefused` comes from the GitHub service, which knows the wording of those errors. */
export function problemFrom(
  message: string,
  signInRefused: boolean,
  previous: SyncProblem | null,
  now = Date.now()
): SyncProblem {
  const kind = signInRefused ? "sign-in" : /couldn't (reach|connect)/i.test(message) ? "offline" : "other";
  return { kind, message, since: previous?.since ?? now };
}

export const failingForADay = (problem: SyncProblem | null, now = Date.now()): boolean =>
  !!problem && now - problem.since >= DAY;

/** Kept across restarts, so "failing for a day" means a day and not one session. */
export function loadProblem(): SyncProblem | null {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return p && typeof p.since === "number" && typeof p.kind === "string" ? p : null;
  } catch {
    return null;
  }
}

export function storeProblem(problem: SyncProblem | null): void {
  try {
    if (problem) localStorage.setItem(STORAGE_KEY, JSON.stringify(problem));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** The one thing to tell the user about syncing. The most urgent wins. */
export function describeSync(
  status: RepoStatusPayload | null,
  problem: SyncProblem | null,
  now = Date.now()
): SyncDescription {
  if (status && !status.remote_url) {
    return {
      kind: "signed-out",
      label: "This device only",
      headline: "Not signed in",
      detail: "Your notes are saved on this device only. Sign in to back them up and sync across devices.",
    };
  }
  const waiting = (status?.files ?? []).filter((f) => f.not_uploaded).length;
  const overdue =
    failingForADay(problem, now) && waiting > 0 ? " They have not been uploaded for over a day." : "";
  const kept = waiting > 0 ? ` ${plural(waiting, "changed file")} kept on this device.${overdue}` : "";

  if (problem?.kind === "sign-in") {
    return {
      kind: "sign-in",
      label: "Sign in needed",
      headline: "Sign in again to keep syncing",
      detail: `GitHub no longer accepts the saved sign-in.${kept}`,
    };
  }
  if (status?.has_conflict) {
    const n = (status.files ?? []).filter((f) => f.conflict).length;
    return {
      kind: "conflict",
      label: n > 1 ? `Conflict (${n})` : "Conflict",
      headline: n > 1 ? `${n} notes need a version chosen` : "A note needs a version chosen",
      detail: `Changed in the same place here and on another device. Open the marked note to choose; everything else keeps syncing.${kept}`,
    };
  }
  if (problem?.kind === "offline") {
    return {
      kind: "offline",
      label: waiting > 0 ? `Offline (${waiting})` : "Offline",
      headline: "Couldn't reach your backup",
      detail: `Check your connection, then sync.${kept}`,
    };
  }
  const others = status?.other_workspaces_not_uploaded ?? [];
  if (waiting > 0 || (status?.ahead_count ?? 0) > 0 || others.length > 0) {
    const elsewhere = others.length > 0 ? ` Changes in ${others.join(", ")} are waiting too.` : "";
    return {
      kind: "waiting",
      label: waiting > 0 ? `Not uploaded (${waiting})` : "Not uploaded",
      headline: waiting > 0 ? `${plural(waiting, "file")} not uploaded` : "Changes not uploaded",
      detail: problem
        ? `The last sync failed: ${problem.message}${overdue}${elsewhere}`
        : `Changes are on this device. They upload when you leave the note or the app, or when you sync now.${elsewhere}`,
    };
  }
  if ((status?.behind_count ?? 0) > 0) {
    const n = status!.behind_count;
    return {
      kind: "updates",
      label: `Updates (${n})`,
      headline: `${plural(n, "update")} available`,
      detail: "Changes from your other devices are waiting. They come in when you return to the app, or sync now.",
    };
  }
  return {
    kind: "synced",
    label: "Synced",
    headline: "Everything is up to date",
    detail: "Nothing on this device is waiting to upload.",
  };
}

/** What started a sync. Everything but "manual" is automatic (SPEC 4.1, 4.2). */
export type SyncReason = "manual" | "launch" | "return" | "leave" | "reconnect" | "idle" | "note-closed";

/** A note left open is committed and uploaded after this long without typing. */
export const IDLE_SYNC_MS = 5 * 60 * 1000;
/** Coming back within this long of the last sync doesn't check again (quick window switches). */
export const RETURN_SYNC_GAP_MS = 15 * 1000;

/** Leaving only needs a sync when something is waiting to upload. */
export const LEAVING: ReadonlySet<SyncReason> = new Set(["leave", "idle", "note-closed"]);

export const hasWaitingUploads = (s: RepoStatusPayload | null): boolean =>
  !!s && (s.dirty_count > 0 || s.ahead_count > 0 || (s.other_workspaces_not_uploaded ?? []).length > 0);

/**
 * Whether an automatic sync may start: there is a workspace in the cloud to sync with, the
 * sign-in isn't known to be refused (that fails every time; the pill asks to sign in again), and
 * a return isn't just a quick switch back.
 */
export function mayAutoSync(
  reason: SyncReason,
  status: RepoStatusPayload | null,
  problem: SyncProblem | null,
  lastSyncAt: number,
  now = Date.now()
): boolean {
  if (!status?.remote_url || !status.branch) return false;
  if (problem?.kind === "sign-in") return false;
  if (reason === "return" && now - lastSyncAt < RETURN_SYNC_GAP_MS) return false;
  return true;
}
