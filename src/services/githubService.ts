import {
  DeviceCodeResponse,
  DeviceTokenResponse,
  GitHubUser,
  WorkspaceList,
} from "../types/noetic";
import { NoeticBridge } from "./noeticBridge";

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
  /** Called once, with the access token, when the user approves. A throw is reported via onFailure. */
  onApproved: (token: string) => Promise<void> | void;
  onFailure: (message: string) => void;
}

/** Network errors tolerated in a row while waiting for approval before giving up. */
const MAX_POLL_ERRORS = 4;

/**
 * Waits for the user to approve a device code in the browser. Returns a function that stops it,
 * which callers must run when the screen closes or a new code is requested; otherwise an old
 * attempt could finish a sign-in the user already walked away from.
 */
export function pollDeviceFlow(opts: DeviceFlowPollOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval = Math.max(1, opts.interval || 5);
  let errors = 0;
  const deadline = Date.now() + (opts.expiresIn || 900) * 1000;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fail = (message: string) => {
    if (stopped) return;
    stop();
    opts.onFailure(message);
  };
  const schedule = () => {
    if (!stopped) timer = setTimeout(check, interval * 1000);
  };

  const check = async () => {
    if (stopped) return;
    if (Date.now() > deadline) {
      fail("That code expired. Request a new one to try again.");
      return;
    }
    try {
      const r = await GitHubService.pollDeviceToken(opts.deviceCode);
      if (stopped) return;
      errors = 0;
      if (r.status === "approved" && r.access_token) {
        stop();
        try {
          await opts.onApproved(r.access_token);
        } catch (err) {
          opts.onFailure(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (r.status === "pending") {
        schedule();
      } else if (r.status === "slow_down") {
        interval = r.interval && r.interval > interval ? r.interval : interval + 5;
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
      errors++;
      if (errors >= MAX_POLL_ERRORS) fail(err instanceof Error ? err.message : String(err));
      else schedule();
    }
  };

  schedule();
  return stop;
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
    const { token, user } = auth;
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
   * Save authenticated session to localStorage
   */
  saveGitHubAuth(token: string, user: GitHubUser): void {
    try {
      localStorage.setItem(
        GITHUB_AUTH_STORAGE_KEY,
        JSON.stringify({ token: token.trim(), user })
      );
    } catch (e) {
      console.warn("Failed to persist GitHub auth to localStorage:", e);
    }
  },

  /**
   * Retrieve stored session from localStorage
   */
  getStoredGitHubAuth(): { token: string; user: GitHubUser } | null {
    try {
      const raw = localStorage.getItem(GITHUB_AUTH_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  /**
   * Clear session
   */
  clearGitHubAuth(): void {
    try {
      localStorage.removeItem(GITHUB_AUTH_STORAGE_KEY);
    } catch {}
  },
};
