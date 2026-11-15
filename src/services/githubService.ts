import {
  DeviceCodeResponse,
  DeviceTokenResponse,
  GitHubUser,
  WorkspaceList,
} from "../types/noetic";
import { NoeticBridge, setCloudGuard } from "./noeticBridge";

export const GITHUB_CLIENT_ID = "Ov23liegRfd4WTYsq3Cf";
/**
 * Every account keeps its notes in one private repository with this name. The app never offers a
 * choice of repository; separate sets of notes are workspaces (branches) inside it.
 */
export const NOTES_REPOSITORY_NAME = "noetic-notes";
const GITHUB_AUTH_STORAGE_KEY = "noetic_github_auth";

/** fetch() to GitHub that explains a network failure instead of surfacing "Failed to fetch". */
async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("Couldn't connect. Check your internet connection and try again.");
  }
}

export interface DeviceFlowPollOptions {
  deviceCode: string;
  /** Seconds between checks, from GitHub's response. */
  interval: number;
  /** Seconds until the code expires, from GitHub's response. */
  expiresIn: number;
  /** When the code expires (ms since epoch). Used instead of `expiresIn` when resuming a sign-in. */
  expiresAt?: number;
  /** Called when GitHub asks for more time between checks, with the new spacing in seconds. */
  onIntervalChange?: (seconds: number) => void;
  /**
   * Called once, with the access token and GitHub's full answer (which carries the refresh token
   * for expiring tokens), when the user approves. A throw is reported via onFailure.
   */
  onApproved: (token: string, grant: DeviceTokenResponse) => Promise<void> | void;
  onFailure: (message: string) => void;
}

/** Network errors tolerated in a row while waiting for approval before giving up. */
const MAX_POLL_ERRORS = 4;

/** True while the app is in the background (on a phone: the user is in the browser signing in). */
const appHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Waits for the user to approve a device code in the browser. Returns a function that stops it,
 * which callers must run when the screen closes or a new code is requested; otherwise an old
 * attempt could finish a sign-in the user already walked away from.
 *
 * On a phone the user leaves the app to approve, and a backgrounded app can't be relied on to
 * make requests: they may fail or simply not run. So failures while hidden never end the
 * sign-in, and coming back to the app checks again straight away.
 */
export function pollDeviceFlow(opts: DeviceFlowPollOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval = Math.max(1, opts.interval || 5);
  let errors = 0;
  let checking = false;
  let lastCheck = Date.now();
  const deadline = opts.expiresAt ?? Date.now() + (opts.expiresIn || 900) * 1000;

  const onVisibility = () => {
    if (stopped || appHidden()) return;
    // Back in the app: forget failures from the background and check as soon as GitHub's
    // minimum spacing between checks allows. GitHub measures that spacing between arrivals, so a
    // second is added: a check sent exactly on time can arrive early and earn a "slow down".
    errors = 0;
    schedule(Math.max(0, lastCheck + (interval + 1) * 1000 - Date.now()));
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };
  const fail = (message: string) => {
    if (stopped) return;
    stop();
    opts.onFailure(message);
  };
  function schedule(delayMs = interval * 1000) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, delayMs);
  }

  async function check() {
    if (stopped || checking) return;
    if (Date.now() > deadline) {
      fail("That code expired. Request a new one to try again.");
      return;
    }
    checking = true;
    lastCheck = Date.now();
    try {
      const r = await GitHubService.pollDeviceToken(opts.deviceCode);
      if (stopped) return;
      errors = 0;
      if (r.status === "approved" && r.access_token) {
        stop();
        try {
          await opts.onApproved(r.access_token, r);
        } catch (err) {
          opts.onFailure(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (r.status === "pending") {
        schedule();
      } else if (r.status === "slow_down") {
        interval = r.interval && r.interval > interval ? r.interval : interval + 5;
        opts.onIntervalChange?.(interval);
        schedule();
      } else if (r.status === "denied") {
        fail(r.error_description || "Sign-in was declined on GitHub.");
      } else if (r.status === "expired") {
        fail(r.error_description || "That code expired. Request a new one to try again.");
      } else {
        fail(r.error_description || "Sign-in wasn't completed. Request a new code to try again.");
      }
    } catch (err) {
      if (stopped) return;
      // A failure in the background says nothing about the sign-in; keep waiting.
      if (!appHidden()) errors++;
      if (errors >= MAX_POLL_ERRORS) fail(err instanceof Error ? err.message : String(err));
      else schedule();
    } finally {
      checking = false;
    }
  }

  schedule();
  return stop;
}

const PENDING_SIGN_IN_STORAGE_KEY = "noetic_pending_sign_in";

/**
 * The saved sign-in. GitHub's user tokens can expire after 8 hours; when they do, GitHub also
 * sends a refresh token (valid for six months, renewed by every use) that is swapped for a new
 * pair before the access token runs out. That keeps the account signed in indefinitely as long
 * as the app is opened at least once every six months.
 */
export interface StoredGitHubAuth {
  token: string;
  user: GitHubUser;
  refreshToken?: string;
  /** When `token` stops working (ms since epoch). Absent for tokens that don't expire. */
  expiresAt?: number;
  /** When `refreshToken` stops working (ms since epoch). */
  refreshTokenExpiresAt?: number;
  /** Set once GitHub has refused the refresh token: only signing in again helps. */
  needsSignIn?: boolean;
}

/** Renew this long before the access token expires, so a slow sync never starts with a dying token. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** The renewal in progress. A refresh token works once, so two renewals at once would sign out. */
let refreshInFlight: Promise<string | null> | null = null;

/** Notes folders whose saved copy of the token is known to match the current one. */
const vaultsInStep = new Map<string, string>();

/** Called after the token changes, e.g. to update the notes folder's saved copy. */
const tokenListeners = new Set<(token: string) => void>();

/** Message shown when the sign-in can't be renewed and the user must sign in again. */
export const SIGN_IN_AGAIN_MESSAGE = "Your GitHub sign-in has ended. Sign in again from Settings to keep syncing.";

/** True for errors that mean GitHub turned the saved sign-in down. */
export function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return (
    msg.includes("sign-in was not accepted") ||
    msg.includes("authentication") ||
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("bad credentials") ||
    msg.includes("too many redirects or authentication replays")
  );
}

/** A sign-in the user has started but not yet approved, kept so it survives the app restarting. */
export interface PendingSignIn {
  device: DeviceCodeResponse;
  /** When the code expires (ms since epoch). */
  expiresAt: number;
}

export const GitHubService = {
  /**
   * Start GitHub OAuth Device Flow (returns 8-character user code and verification URI)
   */
  async startDeviceFlow(clientId: string = GITHUB_CLIENT_ID): Promise<DeviceCodeResponse> {
    return NoeticBridge.startDeviceFlow(clientId);
  },

  /**
   * Poll GitHub OAuth Device Flow token
   */
  async pollDeviceToken(
    deviceCode: string,
    clientId: string = GITHUB_CLIENT_ID
  ): Promise<DeviceTokenResponse> {
    return NoeticBridge.pollDeviceToken(deviceCode, clientId);
  },
  /**
   * Check an access token with GitHub and fetch the signed-in user's profile
   */
  async validateToken(token: string): Promise<GitHubUser> {
    const cleanToken = token.trim();
    if (!cleanToken) {
      throw new Error("Sign-in did not complete. Try again.");
    }

    const res = await githubFetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (res.status === 401) {
      throw new Error(
        "Your sign-in has expired. Sign in again to continue."
      );
    }

    if (res.status === 403) {
      throw new Error(
        "GitHub is not accepting requests right now. Wait a minute and try again."
      );
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        errData.message || `GitHub error (HTTP ${res.status}): Failed to authenticate`
      );
    }

    const data = await res.json();
    return {
      login: data.login,
      name: data.name || data.login,
      avatar_url: data.avatar_url,
      email: data.email || null,
      html_url: data.html_url,
    };
  },

  /**
   * Finds the account's notes repository, creating it (private and empty) the first time.
   * Returns the address the notes folder syncs with.
   */
  async ensureNotesRepository(token: string, login: string): Promise<string> {
    const headers = {
      Authorization: `Bearer ${token.trim()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const existing = await githubFetch(
      `https://api.github.com/repos/${encodeURIComponent(login)}/${NOTES_REPOSITORY_NAME}`,
      { headers }
    );
    if (existing.ok) return (await existing.json()).clone_url;
    if (existing.status === 401) {
      throw new Error("Your sign-in has expired. Sign in again to continue.");
    }
    if (existing.status !== 404) {
      const errData = await existing.json().catch(() => ({}));
      throw new Error(errData.message || `Couldn't reach your notes storage (HTTP ${existing.status}).`);
    }

    // Created with no files: the app adds the empty main branch, then one branch per workspace.
    const created = await githubFetch("https://api.github.com/user/repos", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: NOTES_REPOSITORY_NAME,
        description: "Notes synced with Noetic. Managed by the app: each branch is a workspace.",
        private: true,
        auto_init: false,
        has_issues: false,
        has_wiki: false,
        has_projects: false,
      }),
    });
    if (!created.ok) {
      const errData = await created.json().catch(() => ({}));
      throw new Error(
        errData.errors?.[0]?.message || errData.message || `Couldn't set up your notes storage (HTTP ${created.status}).`
      );
    }
    return (await created.json()).clone_url;
  },

  /**
   * Makes the signed-in account's storage ready for this device: finds or creates the notes
   * repository and links the notes folder to it. Returns the workspaces that already exist.
   */
  async setUpStorage(vaultPath: string): Promise<WorkspaceList> {
    const auth = GitHubService.getStoredGitHubAuth();
    if (!auth) throw new Error("Sign in first to sync your notes.");
    const { user } = auth;
    const token = (await GitHubService.getValidToken()) ?? auth.token;
    vaultsInStep.set(vaultPath, token);
    const remoteUrl = await GitHubService.ensureNotesRepository(token, user.login);
    return NoeticBridge.connectVault({
      vault_path: vaultPath,
      remote_url: remoteUrl,
      github_token: token,
      user_name: user.name || user.login,
      user_email: user.email || `${user.login}@users.noreply.github.com`,
    });
  },

  /**
   * Remembers a sign-in that is waiting for approval. A phone can close the app while the user
   * is in the browser; with this the app picks the same code up again when it reopens.
   */
  savePendingSignIn(device: DeviceCodeResponse): PendingSignIn {
    const pending: PendingSignIn = { device, expiresAt: Date.now() + (device.expires_in || 900) * 1000 };
    try {
      localStorage.setItem(PENDING_SIGN_IN_STORAGE_KEY, JSON.stringify(pending));
    } catch {}
    return pending;
  },

  /** The waiting sign-in, if there is one with enough time left to be worth resuming. */
  getPendingSignIn(): PendingSignIn | null {
    try {
      const raw = localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY);
      if (!raw) return null;
      const pending = JSON.parse(raw) as PendingSignIn;
      if (!pending?.device?.device_code || pending.expiresAt - Date.now() < 15_000) {
        localStorage.removeItem(PENDING_SIGN_IN_STORAGE_KEY);
        return null;
      }
      return pending;
    } catch {
      return null;
    }
  },

  /** Records the spacing between checks GitHub asked for, on the waiting sign-in. */
  updatePendingSignInInterval(seconds: number): void {
    try {
      const raw = localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY);
      if (!raw) return;
      const pending = JSON.parse(raw) as PendingSignIn;
      if (!pending?.device) return;
      pending.device.interval = Math.max(pending.device.interval || 0, seconds);
      localStorage.setItem(PENDING_SIGN_IN_STORAGE_KEY, JSON.stringify(pending));
    } catch {}
  },

  clearPendingSignIn(): void {
    try {
      localStorage.removeItem(PENDING_SIGN_IN_STORAGE_KEY);
    } catch {}
  },

  /**
   * Saves the signed-in account. `grant` is GitHub's answer when the token was issued; for
   * expiring tokens it holds the refresh token and lifetimes.
   */
  saveGitHubAuth(token: string, user: GitHubUser, grant?: DeviceTokenResponse): void {
    const now = Date.now();
    const auth: StoredGitHubAuth = { token: token.trim(), user };
    if (grant?.refresh_token) auth.refreshToken = grant.refresh_token.trim();
    if (grant?.expires_in) auth.expiresAt = now + grant.expires_in * 1000;
    if (grant?.refresh_token_expires_in) auth.refreshTokenExpiresAt = now + grant.refresh_token_expires_in * 1000;
    vaultsInStep.clear();
    GitHubService.writeStoredAuth(auth);
  },

  writeStoredAuth(auth: StoredGitHubAuth): void {
    try {
      localStorage.setItem(GITHUB_AUTH_STORAGE_KEY, JSON.stringify(auth));
    } catch (e) {
      console.warn("Failed to persist GitHub auth to localStorage:", e);
    }
  },

  /**
   * Retrieve stored session from localStorage
   */
  getStoredGitHubAuth(): StoredGitHubAuth | null {
    try {
      const raw = localStorage.getItem(GITHUB_AUTH_STORAGE_KEY);
      if (!raw) return null;
      const auth = JSON.parse(raw) as StoredGitHubAuth;
      return auth?.token ? auth : null;
    } catch {
      return null;
    }
  },

  /** Runs `listener` with the new token every time the sign-in is renewed. Returns an unsubscribe. */
  onTokenChanged(listener: (token: string) => void): () => void {
    tokenListeners.add(listener);
    return () => tokenListeners.delete(listener);
  },

  /**
   * The access token to use right now, renewed first when it is about to expire (or when `force`
   * is set, after GitHub turned it down). Never signs the user out: if GitHub can't be reached
   * the current token is returned and the next call tries again. Returns null when signed out.
   */
  async getValidToken(force = false): Promise<string | null> {
    const auth = GitHubService.getStoredGitHubAuth();
    if (!auth) return null;
    if (!auth.refreshToken || auth.needsSignIn) return auth.token;
    const fresh = auth.expiresAt === undefined || auth.expiresAt - Date.now() > REFRESH_MARGIN_MS;
    if (fresh && !force) return auth.token;

    if (!refreshInFlight) {
      refreshInFlight = GitHubService.renewSignIn(auth).finally(() => {
        refreshInFlight = null;
      });
    }
    return (await refreshInFlight) ?? auth.token;
  },

  /** Swaps the refresh token for a new pair and saves it. Null if it couldn't be renewed now. */
  async renewSignIn(auth: StoredGitHubAuth): Promise<string | null> {
    let r: DeviceTokenResponse;
    try {
      r = await NoeticBridge.refreshGitHubToken(auth.refreshToken!, GITHUB_CLIENT_ID);
    } catch (err) {
      // Offline or GitHub unavailable: the saved sign-in is still good, try again later.
      console.warn("[Noetic] Couldn't renew the GitHub sign-in yet:", err);
      return null;
    }
    // Another tab or window may have renewed in the meantime with the same refresh token.
    const latest = GitHubService.getStoredGitHubAuth();
    if (latest && latest.refreshToken !== auth.refreshToken) return latest.token;

    if (r.status === "approved" && r.access_token) {
      const now = Date.now();
      const next: StoredGitHubAuth = {
        token: r.access_token.trim(),
        user: auth.user,
        refreshToken: r.refresh_token?.trim() || auth.refreshToken,
        expiresAt: r.expires_in ? now + r.expires_in * 1000 : undefined,
        refreshTokenExpiresAt: r.refresh_token_expires_in
          ? now + r.refresh_token_expires_in * 1000
          : auth.refreshTokenExpiresAt,
      };
      GitHubService.writeStoredAuth(next);
      for (const listener of tokenListeners) {
        try {
          listener(next.token);
        } catch {}
      }
      return next.token;
    }
    if (r.status === "expired") {
      GitHubService.writeStoredAuth({ ...auth, needsSignIn: true });
    }
    return null;
  },

  /**
   * Checked at start-up. A sign-in that can be renewed is renewed if due. One saved before
   * renewal was supported has no refresh token: if GitHub has already let it expire, the user is
   * asked to sign in once more (after that it renews itself). Network trouble never counts
   * against the sign-in.
   */
  async checkSignIn(): Promise<"signed-out" | "ok" | "needs-sign-in" | "unknown"> {
    const auth = GitHubService.getStoredGitHubAuth();
    if (!auth) return "signed-out";
    if (auth.needsSignIn) return "needs-sign-in";
    if (auth.refreshToken) {
      await GitHubService.getValidToken();
      return GitHubService.getStoredGitHubAuth()?.needsSignIn ? "needs-sign-in" : "ok";
    }
    const res = await githubFetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }).catch(() => null);
    if (!res) return "unknown";
    if (res.status === 401) {
      GitHubService.writeStoredAuth({ ...auth, needsSignIn: true });
      return "needs-sign-in";
    }
    return res.ok ? "ok" : "unknown";
  },

  /**
   * Makes sure the notes folder's saved copy of the token (which saving and syncing use) is the
   * current, unexpired one. Call before anything that talks to the cloud.
   */
  async prepareVaultSignIn(vaultPath: string, force = false): Promise<void> {
    if (!vaultPath) return;
    const token = await GitHubService.getValidToken(force);
    if (!token || vaultsInStep.get(vaultPath) === token) return;
    try {
      await NoeticBridge.setVaultConfig(vaultPath, { github_token: token });
      vaultsInStep.set(vaultPath, token);
    } catch (err) {
      console.warn("[Noetic] Couldn't update the notes folder's sign-in:", err);
    }
  },

  /**
   * Runs a cloud operation with a current token. If GitHub turns the token down, the sign-in is
   * renewed and the operation tried once more, so an expired token never surfaces as an error.
   */
  async withFreshSignIn<T>(vaultPath: string, run: () => Promise<T>): Promise<T> {
    await GitHubService.prepareVaultSignIn(vaultPath);
    try {
      return await run();
    } catch (err) {
      const auth = GitHubService.getStoredGitHubAuth();
      if (!isAuthError(err) || !auth?.refreshToken) throw err;
      const before = auth.token;
      await GitHubService.prepareVaultSignIn(vaultPath, true);
      const after = GitHubService.getStoredGitHubAuth();
      if (after?.needsSignIn) throw new Error(SIGN_IN_AGAIN_MESSAGE);
      if (!after || after.token === before) throw err;
      return run();
    }
  },

  /**
   * Clear session
   */
  clearGitHubAuth(): void {
    vaultsInStep.clear();
    try {
      localStorage.removeItem(GITHUB_AUTH_STORAGE_KEY);
    } catch {}
  },
};

// Every save, sync and workspace change renews an expiring sign-in first.
setCloudGuard((vaultPath, run) => GitHubService.withFreshSignIn(vaultPath, run));
