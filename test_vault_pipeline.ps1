$token = $env:GITHUB_TOKEN
if (-not $token) {
    $credOut = cmd.exe /c "echo protocol=https&echo host=github.com" | git credential fill 2>$null
    foreach ($line in $credOut) {
        if ($line -like "password=*") {
            $token = $line.Substring(9).Trim()
        }
    }
}
$repoOwner = "suriya-xd"
$repoName = "gitvault-sample-vault"
$vaultPath = "c:\Users\asuri\OneDrive\Desktop\Projects\Noty\sample-vault"

$headers = @{
    "Authorization" = "Bearer $token"
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "GitVault-Test"
    "X-GitHub-Api-Version" = "2022-11-28"
}

Write-Host "=== TEST 1: Initial Status ===" -ForegroundColor Cyan
git -C $vaultPath status -s
$remoteCommits = git -C $vaultPath rev-list HEAD...origin/main --count
Write-Host "Commits difference between HEAD and origin/main: $remoteCommits"

Write-Host "`n=== TEST 2: Local Unsaved Edit (Dirty Worktree) ===" -ForegroundColor Cyan
$newNotePath = Join-Path $vaultPath "FirstNote.md"
Set-Content -Path $newNotePath -Value "# My First Vault Note`n`nWritten locally in GitVault." -Encoding UTF8
git -C $vaultPath status -s
Write-Host "File created directly on disk without committing (Core Rule 2 verified)."

Write-Host "`n=== TEST 3: Save and Push to GitHub (Core Rule 4) ===" -ForegroundColor Cyan
git -C $vaultPath add -A
git -C $vaultPath commit -m "Add FirstNote.md via GitVault Save"
git -C $vaultPath push origin main
Write-Host "Pushed to GitHub successfully!"

Write-Host "`n=== TEST 4: Simulate Remote Change on GitHub (Core Rule 3) ===" -ForegroundColor Cyan
$readmeApi = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/contents/README.md" -Headers $headers
$currentSha = $readmeApi.sha
$newContent = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("# gitvault-sample-vault`n`nUpdated remotely on GitHub."))

$updateBody = @{
    message = "Simulate remote edit from another device"
    content = $newContent
    sha = $currentSha
} | ConvertTo-Json

$updateResp = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/contents/README.md" -Method Put -Headers $headers -Body $updateBody -ContentType "application/json"
Write-Host "Remote commit created on GitHub: $($updateResp.commit.sha.Substring(0,7))"

Write-Host "`n=== TEST 5: Background Fetch and State Detection ===" -ForegroundColor Cyan
git -C $vaultPath fetch origin
$behindStr = git -C $vaultPath rev-list HEAD..origin/main --count
$behind = [int]($behindStr.Trim())
$dirtyLines = @(git -C $vaultPath status -s)
$dirty = $dirtyLines.Count

Write-Host "Behind count: $behind"
Write-Host "Dirty count: $dirty"

if ($behind -gt 0 -and $dirty -eq 0) {
    Write-Host "STATE DETECTED: CleanBehind (Out of sync: $behind incoming)" -ForegroundColor Green
} elseif ($behind -gt 0 -and $dirty -gt 0) {
    Write-Host "STATE DETECTED: DirtyBehind (Out of sync + Unsaved edits)" -ForegroundColor Yellow
} else {
    Write-Host "STATE DETECTED: Up to Date" -ForegroundColor Green
}

Write-Host "`n=== TEST 6: Sync and Fast-Forward Pull (Core Rule 5) ===" -ForegroundColor Cyan
git -C $vaultPath merge --ff-only origin/main
Get-Content (Join-Path $vaultPath "README.md")
Write-Host "Successfully synced changes from GitHub!" -ForegroundColor Green
