import type { Plugin } from "vite";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

const execAsync = util.promisify(exec);

export function gitVaultPlugin(): Plugin {
  return {
    name: "vite-gitvault-backend",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/gitvault/")) {
          return next();
        }

        const endpoint = req.url.replace("/api/gitvault/", "").split("?")[0];

        // Parse JSON body
        let body: Record<string, any> = {};
        if (req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk as Buffer);
            }
            const rawBody = Buffer.concat(chunks).toString();
            if (rawBody.trim()) {
              body = JSON.parse(rawBody);
            }
          } catch (e) {
            console.error("Failed to parse request body:", e);
          }
        }

        const defaultVaultPath = path.resolve(process.cwd(), "sample-vault");
        const vaultPath = body.repo_path || body.vault_path || defaultVaultPath;

        const sendJson = (data: any, statusCode = 200) => {
          res.statusCode = statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };

        const sendError = (msg: string, statusCode = 500) => {
          res.statusCode = statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: msg }));
        };

        try {
          switch (endpoint) {
            case "init_or_open_vault": {
              sendJson({
                path: vaultPath,
                name: "suriya-xd/gitvault-sample-vault",
                is_git_repo: fs.existsSync(path.join(vaultPath, ".git")),
              });
              break;
            }

            case "list_vault_files": {
              if (!fs.existsSync(vaultPath)) {
                return sendJson([]);
              }
              const entries: any[] = [];
              const items = fs.readdirSync(vaultPath, { withFileTypes: true });
              for (const item of items) {
                if (item.name.startsWith(".") || item.name === "node_modules" || item.name === "target") {
                  continue;
                }
                const fullPath = path.join(vaultPath, item.name);
                const stat = fs.statSync(fullPath);
                entries.push({
                  path: item.name,
                  name: item.name,
                  is_directory: item.isDirectory(),
                  size_bytes: stat.size,
                  modified_ms: stat.mtimeMs,
                });
              }
              sendJson(entries);
              break;
            }

            case "read_file_content": {
              let targetPath = body.full_path || body.path || "";
              if (!targetPath) return sendError("Missing file path", 400);
              if (!path.isAbsolute(targetPath)) {
                targetPath = path.join(vaultPath, targetPath);
              }
              if (fs.existsSync(targetPath)) {
                const content = fs.readFileSync(targetPath, "utf-8");
                sendJson(content);
              } else {
                sendJson("");
              }
              break;
            }

            case "write_file_content": {
              let targetPath = body.full_path || body.path || "";
              if (!targetPath) return sendError("Missing file path", 400);
              if (!path.isAbsolute(targetPath)) {
                targetPath = path.join(vaultPath, targetPath);
              }
              const dir = path.dirname(targetPath);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              fs.writeFileSync(targetPath, body.content || "", "utf-8");
              sendJson({ success: true });
              break;
            }

            case "create_file": {
              const fullPath = path.join(vaultPath, body.rel_path);
              const dir = path.dirname(fullPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              if (!fs.existsSync(fullPath)) {
                fs.writeFileSync(fullPath, `# ${body.rel_path.replace(".md", "")}\n\n`, "utf-8");
              }
              sendJson({ success: true });
              break;
            }

            case "delete_file": {
              const fullPath = path.join(vaultPath, body.rel_path);
              if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
              }
              sendJson({ success: true });
              break;
            }

            case "rename_file": {
              const oldPath = path.join(vaultPath, body.old_path);
              const newPath = path.join(vaultPath, body.new_path);
              if (fs.existsSync(oldPath)) {
                fs.renameSync(oldPath, newPath);
              }
              sendJson({ success: true });
              break;
            }

            case "get_repo_status": {
              const statusData = await getGitStatus(vaultPath);
              sendJson(statusData);
              break;
            }

            case "fetch_remote": {
              try {
                await execAsync("git fetch origin", { cwd: vaultPath });
              } catch (e) {
                console.warn("fetch failed (offline?):", e);
              }
              const statusData = await getGitStatus(vaultPath);
              sendJson(statusData);
              break;
            }

            case "save_and_push": {
              const preStatus = await getGitStatus(vaultPath);
              if (preStatus.behind_count > 0) {
                return sendError(`Cannot save and push: remote is ahead by ${preStatus.behind_count} commit(s). Please click 'Sync' first.`);
              }
              // Stage all files
              await execAsync("git add -A", { cwd: vaultPath });
              const msg = body.commit_message || `Vault update: ${new Date().toISOString()}`;
              await execAsync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: vaultPath });
              
              // Push to origin
              try {
                await execAsync("git push origin main", { cwd: vaultPath });
              } catch (pushErr: any) {
                console.warn("Push failed (offline?):", pushErr.message);
              }

              const postStatus = await getGitStatus(vaultPath);
              sendJson(postStatus);
              break;
            }

            case "sync_and_pull": {
              try {
                await execAsync("git fetch origin", { cwd: vaultPath });
              } catch (e) {
                console.warn("Fetch failed during sync:", e);
              }

              const status = await getGitStatus(vaultPath);
              if (status.behind_count === 0) {
                return sendJson({
                  success: true,
                  message: "Repository is already up to date.",
                  state: status.state,
                  conflicts: [],
                });
              }

              // Check if overlapping
              const dirtyFiles = status.files.filter((f: any) => f.is_modified || f.is_untracked).map((f: any) => f.path);
              const remoteFiles = status.files.filter((f: any) => f.has_remote_update).map((f: any) => f.path);
              const overlapping = dirtyFiles.filter((p: string) => remoteFiles.includes(p));

              if (overlapping.length > 0) {
                // In-memory 3-way conflict simulation/detection
                const conflicts = [];
                for (const p of overlapping) {
                  let base = "";
                  let remote = "";
                  try {
                    const { stdout: b } = await execAsync(`git show HEAD:${p}`, { cwd: vaultPath });
                    base = b;
                  } catch {}
                  try {
                    const { stdout: r } = await execAsync(`git show origin/main:${p}`, { cwd: vaultPath });
                    remote = r;
                  } catch {}
                  const local = fs.existsSync(path.join(vaultPath, p)) ? fs.readFileSync(path.join(vaultPath, p), "utf-8") : "";

                  conflicts.push({
                    path: p,
                    base_content: base,
                    local_content: local,
                    remote_content: remote,
                    hunks: [
                      {
                        id: `hunk_${p}`,
                        base_lines: base,
                        local_lines: local,
                        remote_lines: remote,
                      },
                    ],
                  });
                }

                return sendJson({
                  success: false,
                  message: `Conflict detected in ${conflicts.length} file(s). Please resolve in the Visual Conflict Resolver.`,
                  state: "DirtyBehind",
                  conflicts,
                });
              }

              // Non-overlapping: stash if dirty, pull, pop stash
              const hadDirty = dirtyFiles.length > 0;
              if (hadDirty) {
                try { await execAsync("git stash save -u 'GitVault sync auto-stash'", { cwd: vaultPath }); } catch {}
              }
              await execAsync("git merge --ff-only origin/main", { cwd: vaultPath });
              if (hadDirty) {
                try { await execAsync("git stash pop", { cwd: vaultPath }); } catch {}
              }

              const postStatus = await getGitStatus(vaultPath);
              sendJson({
                success: true,
                message: "Successfully synced with GitHub!",
                state: postStatus.state,
                conflicts: [],
              });
              break;
            }

            case "resolve_conflicts": {
              const resolutions = body.resolutions || [];
              for (const resItem of resolutions) {
                if (resItem.custom_content !== undefined) {
                  const targetPath = path.join(vaultPath, resItem.path);
                  fs.writeFileSync(targetPath, resItem.custom_content, "utf-8");
                }
              }
              await execAsync("git add -A", { cwd: vaultPath });
              await execAsync('git commit -m "Merge branch origin/main: Resolved conflicts via GitVault"', { cwd: vaultPath });
              try {
                await execAsync("git push origin main", { cwd: vaultPath });
              } catch {}
              const postStatus = await getGitStatus(vaultPath);
              sendJson(postStatus);
              break;
            }

            default:
              sendError(`Unknown endpoint: ${endpoint}`, 404);
          }
        } catch (err: any) {
          console.error(`Error in endpoint ${endpoint}:`, err);
          sendError(err.message || String(err), 500);
        }
      });
    },
  };
}

async function getGitStatus(vaultPath: string) {
  let dirtyCount = 0;
  const fileStatuses: any[] = [];

  try {
    const { stdout: statusOut } = await execAsync("git status --porcelain=v1", { cwd: vaultPath });
    const lines = statusOut.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const code = line.substring(0, 2);
      const filePath = line.substring(3).trim().replace(/\\/g, "/");
      const isUntracked = code.includes("?");
      const isModified = !isUntracked;
      fileStatuses.push({
        path: filePath,
        is_modified: isModified,
        is_untracked: isUntracked,
        has_remote_update: false,
      });
      dirtyCount++;
    }
  } catch (e) {
    console.error("git status failed:", e);
  }

  let aheadCount = 0;
  let behindCount = 0;
  try {
    const { stdout: revCount } = await execAsync("git rev-list HEAD...origin/main --count --left-right", { cwd: vaultPath });
    const [ahead, behind] = revCount.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
    aheadCount = ahead;
    behindCount = behind;
  } catch {}

  // Check diff against remote
  if (behindCount > 0) {
    try {
      const { stdout: diffFiles } = await execAsync("git diff --name-only HEAD origin/main", { cwd: vaultPath });
      const changed = diffFiles.split("\n").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean);
      for (const p of changed) {
        const existing = fileStatuses.find((f) => f.path === p);
        if (existing) {
          existing.has_remote_update = true;
        } else {
          fileStatuses.push({
            path: p,
            is_modified: false,
            is_untracked: false,
            has_remote_update: true,
          });
        }
      }
    } catch {}
  }

  let state = "CleanSynced";
  if (behindCount > 0) {
    state = dirtyCount > 0 ? "DirtyBehind" : "CleanBehind";
  } else if (aheadCount > 0) {
    state = "AheadOffline";
  } else if (dirtyCount > 0) {
    state = "DirtySynced";
  } else {
    state = "CleanSynced";
  }

  return {
    state,
    dirty_count: dirtyCount,
    behind_count: behindCount,
    ahead_count: aheadCount,
    branch: "main",
    remote_name: "origin",
    files: fileStatuses,
    last_synced_at: new Date().toLocaleTimeString(),
  };
}
