<#
.SYNOPSIS
    Install dsh-codex-responses into a DSH profile.

.DESCRIPTION
    1. Creates a junction from the profile's node_modules to this repository.
    2. Optionally mounts the plugin by delegating to scripts/apply-profile.mjs.

    This script contains no YAML editing logic of its own. Windows PowerShell 5.1
    decodes BOM-less UTF-8 as ANSI, which corrupts CJK text in cordis.patch.yml,
    so all profile edits go through the Node script, which reads and writes utf8
    deterministically and aborts if the CJK character count changes.

.PARAMETER Source
    Plugin repository path. Default: D:\dsh-codex-responses

.PARAMETER ProfileDir
    DSH profile directory. Default: C:\Users\73985\.dsh\profiles\web

.PARAMETER PatchProfile
    Also mount the plugin in cordis.patch.yml (delegates to apply-profile.mjs).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -PatchProfile
#>
[CmdletBinding()]
param(
    [string]$Source = 'D:\dsh-codex-responses',
    [string]$ProfileDir = 'C:\Users\73985\.dsh\profiles\web',
    [switch]$PatchProfile
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-codex-responses'

function Write-Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "   !   $msg" -ForegroundColor Yellow }

# --- 1. validate plugin source --------------------------------------------
Write-Step 'checking plugin source'
if (-not (Test-Path $Source)) { throw "plugin source not found: $Source" }
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "$Source has no package.json" }
if (-not (Test-Path (Join-Path $Source 'lib\index.js'))) { throw "$Source has no lib\index.js" }
Write-Ok $Source

# --- 2. validate profile --------------------------------------------------
Write-Step 'checking DSH profile'
if (-not (Test-Path $ProfileDir)) { throw "profile not found: $ProfileDir" }
$nodeModules = Join-Path $ProfileDir 'node_modules'
if (-not (Test-Path $nodeModules)) { throw "$ProfileDir has no node_modules; not a DSH profile" }
Write-Ok $ProfileDir

# --- 3. junction ----------------------------------------------------------
Write-Step "linking plugin into $nodeModules"
$target = Join-Path $nodeModules $pluginName

if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType -eq 'Junction' -and $item.Target -contains $Source) {
        Write-Ok "junction already points at $Source"
    }
    else {
        Write-Warn2 "$target exists and is not a junction to this repository; left unchanged"
    }
}
else {
    New-Item -ItemType Junction -Path $target -Target $Source | Out-Null
    Write-Ok "junction created: $target -> $Source"
}

# --- 4. mount -------------------------------------------------------------
Write-Step 'mounting plugin in cordis.patch.yml'

if ($PatchProfile) {
    $applyScript = Join-Path $Source 'scripts\apply-profile.mjs'
    if (-not (Test-Path $applyScript)) { throw "missing $applyScript" }
    & node $applyScript --profile-dir $ProfileDir
    if ($LASTEXITCODE -ne 0) { throw "apply-profile.mjs failed with exit code $LASTEXITCODE" }
}
else {
    Write-Warn2 '-PatchProfile not given; configuration left untouched. Run:'
    Write-Host "   node `"$Source\scripts\apply-profile.mjs`" --profile-dir `"$ProfileDir`"" -ForegroundColor DarkGray
    Write-Host '   (do NOT hand-edit the YAML; the row must be wrapped in "- insert:")' -ForegroundColor DarkGray
}

# --- 5. next steps --------------------------------------------------------
Write-Step 'next steps'
Write-Host @'
   1. Make sure the target provider uses:  api: openai-responses
   2. DSH hot-reloads patch-layer changes. If the plugin is still absent from
      the plugin list, restart DSH once.
   3. Verify:  node D:\dsh-codex-responses\test\smoke.mjs
'@ -ForegroundColor DarkGray
