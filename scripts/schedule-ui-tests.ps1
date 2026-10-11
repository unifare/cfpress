# Schedule the UI acceptance run (black-box + MidScene) on a Windows machine.
#
#   .\scripts\schedule-ui-tests.ps1 -Install    register a daily task
#   .\scripts\schedule-ui-tests.ps1 -Status     show what is registered
#   .\scripts\schedule-ui-tests.ps1 -Remove     unregister
#
# What the scheduled task actually runs:
#   node scripts\run-ui-tests.mjs --report
#
# The runner starts its own `wrangler dev` (clearing the proxy variables that
# crash workerd on this machine), runs the deterministic Playwright black-box
# suite and — when a vision model is configured — the MidScene visual and
# functional suites, then files one GitHub issue per NEW finding. It always
# tears its dev server down first, so an interrupted run cannot leave a
# wrangler process holding the port.
#
# The MidScene model is optional: with no key the run is green-minus-key and
# prints how to configure one, rather than failing the scheduled task.
#
# NOTE: BOM. This file must stay UTF-8 **with BOM** — Windows PowerShell 5.1
# reads a BOM-less .ps1 as ANSI and the Chinese comments below turn into
# mojibake at parse time (the same rule scripts/cfpress.ps1 follows).

param(
  [switch]$Install,
  [switch]$Status,
  [switch]$Remove,
  [string]$Time = "09:00",
  [string]$TaskName = "CFPress UI tests"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root "scripts\run-ui-tests.mjs"

function Show-Usage {
  Write-Host @"
Usage:
  .\scripts\schedule-ui-tests.ps1 -Install [-Time HH:mm] [-TaskName <name>]
  .\scripts\schedule-ui-tests.ps1 -Status
  .\scripts\schedule-ui-tests.ps1 -Remove [-TaskName <name>]

The task runs:  node $runner --report
Logs land in:  $root\.tmp-ui\logs\
"@
}

if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    $t | Select-Object TaskName, State | Format-List
    $t.Actions | Select-Object Execute, Arguments | Format-List
  } else { Write-Host "no task named '$TaskName'" }
  exit 0
}

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed '$TaskName' (if it existed)"
  exit 0
}

if (-not $Install) { Show-Usage; exit 0 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "node is not on PATH — the scheduled task would not run"; exit 1 }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$runner`" --report" -WorkingDirectory $root
# Daily, and repeat once within an hour if the machine misses the window
# (a laptop that was asleep at 09:00 should still get its run).
# NOTE: the cmdlet is New-ScheduledTaskTrigger in Windows PowerShell 5.1 (the
# version that runs .ps1 by default here) — the `New-ScheduledTaskTaskTrigger`
# spelling only exists in newer modules and fails as "not recognized".
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "CFPress UI acceptance: Playwright black-box + MidScene visual/functional suites; files new findings as GitHub issues." | Out-Null

Write-Host "registered '$TaskName' at $Time daily -> node $runner --report"
Write-Host "logs: $root\.tmp-ui\logs\"
Write-Host ""
Write-Host "to enable the vision+functional suites, set once (persisted for the task):"
Write-Host "  setx MIDSCENE_MODEL_API_KEY `"sk-...`""
Write-Host "  setx MIDSCENE_MODEL_NAME `"qwen-vl-max`""
Write-Host ""
Write-Host "smoke-test the task now:  Start-ScheduledTask -TaskName '$TaskName'"
