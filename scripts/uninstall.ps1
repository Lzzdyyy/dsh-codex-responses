<#
.SYNOPSIS
    Remove the dsh-codex-responses junction from a DSH profile.

.DESCRIPTION
    Only removes the junction; the plugin source directory is never touched.
    Refuses to act on a real directory. Configuration changes are delegated to
    scripts/apply-profile.mjs --revert (Node, deterministic utf8).

.PARAMETER ProfileDir
    DSH profile directory. Default: C:\Users\73985\.dsh\profiles\web

.PARAMETER RemoveProfileEntry
    Also unmount the plugin from cordis.patch.yml (delegates to apply-profile.mjs --revert).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveProfileEntry
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = 'C:\Users\73985\.dsh\profiles\web',
    [switch]$RemoveProfileEntry
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-codex-responses'

function Write-Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "   !   $msg" -ForegroundColor Yellow }

# --- 1. remove junction ---------------------------------------------------
Write-Step 'removing plugin junction'
$target = Join-Path (Join-Path $ProfileDir 'node_modules') $pluginName

if (-not (Test-Path $target)) {
    Write-Warn2 "$target not found; nothing to remove"
}
else {
    $item = Get-Item $target -Force
    if ($item.LinkType -eq 'Junction') {
        # Remove-Item on a junction deletes only the link, not the target
        Remove-Item $target -Force
        Write-Ok "junction removed: $target"
        Write-Host '   plugin source directory left untouched' -ForegroundColor DarkGray
    }
    else {
        Write-Warn2 "$target is not a junction (possibly a copy); stopped without deleting anything"
    }
}

# --- 2. unmount -----------------------------------------------------------
Write-Step 'unmounting from cordis.patch.yml'

if ($RemoveProfileEntry) {
    $applyScript = Join-Path $PSScriptRoot 'apply-profile.mjs'
    if (-not (Test-Path $applyScript)) { throw "missing $applyScript" }
    & node $applyScript --profile-dir $ProfileDir --revert
    if ($LASTEXITCODE -ne 0) { throw "apply-profile.mjs --revert failed with exit code $LASTEXITCODE" }
}
else {
    Write-Warn2 'configuration left untouched. To remove the loader row run:'
    Write-Host "   node D:\dsh-codex-responses\scripts\apply-profile.mjs --revert --profile-dir `"$ProfileDir`"" -ForegroundColor DarkGray
}

Write-Step 'reminder'
Write-Host @'
   Restart DSH to fully unload the plugin.
   If you keep the provider on api: openai-responses without this plugin,
   the gateway's prompt injection comes back. Switch it to openai-completions
   or keep the plugin installed.
'@ -ForegroundColor DarkGray
