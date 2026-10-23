import {
  DeviceCodeResponse,
  DeviceTokenResponse,
  GitHubRepo,
  GitHubUser,
} from "../types/gitVault";
import { GitVaultBridge } from "./gitVaultBridge";

export const GITHUB_CLIENT_ID = "Ov23liegRfd4WTYsq3Cf";
const GITHUB_AUTH_STORAGE_KEY = "gitvault_github_auth";

export const GitHubService = {
  /**
   * Start GitHub OAuth Device Flow (returns 8-character user code and verification URI)
   */
  async startDeviceFlow(clientId: string = GITHUB_CLIENT_ID): Promise<DeviceCodeResponse> {
    return GitVaultBridge.startDeviceFlow(clientId);
  },

  /**
   * Poll GitHub OAuth Device Flow token
   */
  async pollDeviceToken(
    deviceCode: string,
    clientId: string = GITHUB_CLIENT_ID
  ): Promise<DeviceTokenResponse> {
    return GitVaultBridge.pollDeviceToken(deviceCode, clientId);
  },
  /**
   * Validate a Personal Access Token and fetch user profile
   */
  async validateToken(token: string): Promise<GitHubUser> {
    const cleanToken = token.trim();
    if (!cleanToken) {
      throw new Error("GitHub token cannot be empty.");
    }

    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (res.status === 401) {
      throw new Error(
        "Invalid GitHub token. Please verify your token and ensure it hasn't expired."
      );
    }

    if (res.status === 403) {
      throw new Error(
        "GitHub API rate limit exceeded or access forbidden. Check your token permissions."
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
   * Fetch all repositories owned or collaborated on by the authenticated user
   */
  async listUserRepositories(token: string): Promise<GitHubRepo[]> {
    const cleanToken = token.trim();
    const res = await fetch(
      "https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator",
      {
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        errData.message || `Failed to fetch repositories (HTTP ${res.status})`
      );
    }

    const list = await res.json();
    return list.map((item: any) => ({
      id: item.id,
      name: item.name,
      full_name: item.full_name,
      private: item.private,
      html_url: item.html_url,
      clone_url: item.clone_url,
      default_branch: item.default_branch || "main",
      description: item.description || null,
      updated_at: item.updated_at,
    }));
  },

  /**
   * Create a new GitHub repository for the vault
   */
  async createRepository(
    token: string,
    options: {
      name: string;
      description?: string;
      isPrivate: boolean;
    }
  ): Promise<GitHubRepo> {
    const cleanToken = token.trim();
    const cleanName = options.name.trim();

    if (!cleanName) {
      throw new Error("Repository name is required.");
    }

    const res = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        name: cleanName,
        description:
          options.description || "Markdown notes synchronized with GitVault",
        private: options.isPrivate,
        auto_init: true, // Creates initial commit with README.md so repo has main branch ready
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        errData.message ||
          (errData.errors?.[0]?.message
            ? `${errData.message}: ${errData.errors[0].message}`
            : `Failed to create repository (HTTP ${res.status})`)
      );
    }

    const item = await res.json();
    return {
      id: item.id,
      name: item.name,
      full_name: item.full_name,
      private: item.private,
      html_url: item.html_url,
      clone_url: item.clone_url,
      default_branch: item.default_branch || "main",
      description: item.description || null,
      updated_at: item.updated_at,
    };
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
