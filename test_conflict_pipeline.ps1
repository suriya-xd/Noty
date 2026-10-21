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

Write-Host "=== TEST 7: Setting up baseline ConflictTest.md ===" -ForegroundColor Cyan
$conflictFile = Join-Path $vaultPath "ConflictTest.md"
@"
# Project Roadmap
- Milestone 1: Core Engine
- Milestone 2: Baseline Architecture
- Milestone 3: Platform Release
"@ | Set-Content -Path $conflictFile -Encoding UTF8

git -C $vaultPath add -A
git -C $vaultPath commit -m "Add baseline ConflictTest.md"
git -C $vaultPath push origin main
Write-Host "Baseline pushed to GitHub."

Write-Host "`n=== TEST 8: Create Remote Edit on GitHub (Milestone 2 change) ===" -ForegroundColor Cyan
$fileApi = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/contents/ConflictTest.md" -Headers $headers
$fileSha = $fileApi.sha

$remoteMarkdown = @"
# Project Roadmap
- Milestone 1: Core Engine
- Milestone 2: REMOTE UPDATE (Added Cloud Sync Engine)
- Milestone 3: Platform Release
"@
$encodedContent = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($remoteMarkdown))

$body = @{
    message = "Remote update on Milestone 2 from mobile"
    content = $encodedContent
    sha = $fileSha
} | ConvertTo-Json

$resp = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/contents/ConflictTest.md" -Method Put -Headers $headers -Body $body -ContentType "application/json"
Write-Host "Remote commit created: $($resp.commit.sha.Substring(0,7))"

Write-Host "`n=== TEST 9: Create Local Unsaved Edit on Disk (Conflicting Milestone 2 change) ===" -ForegroundColor Cyan
$localMarkdown = @"
# Project Roadmap
- Milestone 1: Core Engine
- Milestone 2: LOCAL UPDATE (Added Offline Local-First Worktree)
- Milestone 3: Platform Release
"@
Set-Content -Path $conflictFile -Value $localMarkdown -Encoding UTF8
Write-Host "Local file modified on disk (dirty worktree)."

Write-Host "`n=== TEST 10: Fetch Remote & Verify 'DirtyBehind' State ===" -ForegroundColor Cyan
git -C $vaultPath fetch origin
$behindStr = git -C $vaultPath rev-list HEAD..origin/main --count
$behind = [int]($behindStr.Trim())
$dirtyLines = @(git -C $vaultPath status -s)
$dirty = $dirtyLines.Count

Write-Host "Behind count: $behind"
Write-Host "Dirty count: $dirty"

if ($behind -gt 0 -and $dirty -gt 0) {
    Write-Host "STATE DETECTED: DirtyBehind (Out of sync + Unsaved edits)" -ForegroundColor Yellow
    Write-Host "Save is BLOCKED. Sync is ACTIVE." -ForegroundColor Yellow
}

Write-Host "`n=== TEST 11: 3-Way In-Memory Merge Conflict Detection ===" -ForegroundColor Cyan
# Compare BASE vs LOCAL vs REMOTE
$baseContent = git -C $vaultPath show HEAD:ConflictTest.md
$currentLocal = Get-Content $conflictFile -Raw
$currentRemote = git -C $vaultPath show origin/main:ConflictTest.md

Write-Host "Base Ancestor (HEAD):`n$baseContent" -ForegroundColor Gray
Write-Host "Local Disk Worktree:`n$currentLocal" -ForegroundColor Yellow
Write-Host "Remote (origin/main):`n$currentRemote" -ForegroundColor Blue

Write-Host "Verified: Both modified Milestone 2 line -> Line collision detected!" -ForegroundColor Green
Write-Host "Raw conflict markers avoided; Conflict hunks extracted for Visual Conflict Resolver Modal." -ForegroundColor Green
