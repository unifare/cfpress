# dev-hosts.ps1 - elevated wrapper for scripts/dev-hosts.mjs
#
# Writing the hosts file needs an administrator token. This wrapper is the
# convenience path: run it from a normal shell and it re-launches itself
# elevated (UAC prompt), runs the Node tool, and keeps the window open long
# enough to read the output.
#
# It contains no logic of its own on purpose - the single implementation is
# scripts/dev-hosts.mjs, and this file only answers "may I write the file".
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\dev-hosts.ps1 <list|add|remove|verify> [--dry-run]

param([string]$Action = "list", [string]$Extra = "")

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$tool = Join-Path $here "dev-hosts.mjs"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    # Re-launch elevated and wait. The inner window must stay open to be read,
    # so it ends with a prompt rather than closing itself.
    $argList = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-Command",
        "Set-Location '$root'; node '$tool' $Action $Extra; Write-Host ''; Read-Host 'Press Enter to close'"
    )
    Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs -Wait
    exit $LASTEXITCODE
}

node $tool $Action $Extra
exit $LASTEXITCODE
