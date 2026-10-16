<#
.SYNOPSIS
    CFPress launcher for Windows (PowerShell).

.DESCRIPTION
    Two ways in, one set of actions:

        .\scripts\cfpress.ps1                  numeric menu, loops until you exit
        .\scripts\cfpress.ps1 dev              command mode, one action, exits
        .\scripts\cfpress.ps1 test multisite   command mode with arguments

    The menu and the command mode call the same Invoke-Action function. There is
    no second implementation of "deploy" hiding in the menu branch — a launcher
    whose menu and CLI can drift apart is two launchers, and only one of them
    gets tested.

    This file is the Windows counterpart of scripts/cfpress.sh and is kept
    deliberately parallel to it: same action names, same menu numbers, same exit
    codes. If you add an action, add it to both.

    Windows PowerShell 5.1 compatible on purpose — no `&&`, no ternary `?:`, no
    null-coalescing `??`. Those are PowerShell 7 features and this script must
    run on the PowerShell that ships with Windows.

.PARAMETER Action
    The action to run. Omit it to get the interactive menu.

.PARAMETER Args
    Extra arguments for the action (a suite name, a theme directory, --force).

.EXAMPLE
    .\scripts\cfpress.ps1
    Start the numeric menu.

.EXAMPLE
    .\scripts\cfpress.ps1 test architecture
    Run one test suite.

.EXAMPLE
    .\scripts\cfpress.ps1 deploy --force
    Deploy even though wrangler.jsonc still has placeholder ids.

.NOTES
    Exit codes
      0  the action succeeded
      1  the action failed, or the user aborted
      2  usage error — unknown action, bad argument, missing prerequisite
      3  refused on a precondition the user can fix (see deploy)
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Action,

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

# NOT `$ErrorActionPreference = 'Stop'`.
#
# Windows PowerShell 5.1 wraps anything a native command writes to stderr in a
# NativeCommandError record, and with `Stop` that record becomes a *terminating*
# error. So `node tests/suites/x.test.mjs 2>&1` — where node prints a harmless
# `ExperimentalWarning: SQLite is an experimental feature` to stderr, and every
# suite in this repo does — aborts the launcher before the suite can report
# anything. The symptom is a launcher that dies mid-run with a stray node
# warning and no summary, which is exactly the failure mode AGENTS.md warns
# about. `Continue` plus explicit `exit` codes keeps every failure visible and
# attributable.
$ErrorActionPreference = 'Continue'

# --- locate the project root -------------------------------------------------
# Scripts may be invoked from anywhere; every command must run from the repo
# root because wrangler.jsonc, migrations/ and node_modules/ are all relative.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir '..')).Path
Set-Location $Root

# The generated deploy config, and the two files it is derived from.
#
# `$ConfigFile` is what every wrangler command below is pointed at with `-c`. It
# is NOT the committed file: `wrangler.jsonc` carries REPLACE_WITH_* placeholders
# so a public clone never publishes account-scoped ids, and the real values live
# in `wrangler.ids.json` (gitignored). `Invoke-EnsureConfig` below runs the
# generator that joins them.
#
# WARNING: this used to be `'wrangler.jsonc'` with `wrangler deploy` given no
# `-c` at all, and the refusal message told the operator to *edit the committed
# template* with their real ids. That is a leak: `wrangler.jsonc` is tracked, so
# the next `git commit -a` publishes the ids of a live database. The two files
# were also free to drift, and did — batch 11 put the feature-switch `vars`
# block in the template only, so the deployed Worker had no `vars` at all.
$ConfigFile = 'wrangler.local.jsonc'
$TemplateFile = 'wrangler.jsonc'
$IdsFile = 'wrangler.ids.json'
$DbName = 'cfpress'
# Deliberately an uncommon port. 8787 is the default for `wrangler dev`, so it
# collides with every other Wrangler project on the machine (and with the two
# wrangler dev instances that cause SQLITE_BUSY). 47913 is in the private range
# and is not the default of any tool we use. Override with CFP_PORT.
$DevPort = if ($env:CFP_PORT) { $env:CFP_PORT } else { '47913' }
$DevHost = if ($env:CFP_HOST) { $env:CFP_HOST } else { '127.0.0.1' }
$DevUrl = "http://${DevHost}:${DevPort}"

# --- output helpers ----------------------------------------------------------
# No colour when the host does not have a console (redirected output, CI), so
# piping the launcher into a log does not litter it with escape codes.
$UseColor = $true
if ($env:NO_COLOR -ne $null) { $UseColor = $false }
try { if (-not $Host.UI.SupportsVirtualTerminal) { $UseColor = $false } } catch { $UseColor = $false }
if ($env:TERM -eq 'dumb') { $UseColor = $false }

function Write-Line  { param([string]$Text = '') Write-Host $Text }
function Write-Head  { param([string]$Text) Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Text) Write-Host "  ok  $Text" -ForegroundColor Green }
function Write-Warn2 { param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }
function Write-Err2  { param([string]$Text) Write-Host "  XX  $Text" -ForegroundColor Red }
function Write-Dim   { param([string]$Text) Write-Host "  $Text" -ForegroundColor DarkGray }

function Die {
    param([string]$Text)
    Write-Err2 $Text
    exit 2
}

# --- prerequisites -----------------------------------------------------------
function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Node {
    if (-not (Test-Command 'node')) { Die 'node not found on PATH — install Node.js 20+ first' }
}

function Assert-Deps {
    if (-not (Test-Path 'node_modules')) { Die 'node_modules\ missing — run: npm install (or: .\scripts\cfpress.ps1 install)' }
    if (-not (Test-Path 'node_modules\.bin\wrangler.cmd')) { Die 'wrangler missing — run: npm install (or: .\scripts\cfpress.ps1 install)' }
}

# In PowerShell, `npx.ps1` / `npm.ps1` trip execution-policy on locked-down
# machines; `cmd` shims have no such problem. Prefer the .cmd and never rely on
# the ambient shell resolving this for us.
function Invoke-Npx {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    if (Test-Path 'node_modules\.bin\wrangler.cmd') {
        # `npx --no-install` still downloads when the package is absent; the
        # local .cmd is the same binary without the network behaviour.
        if ($Arguments.Length -gt 0 -and $Arguments[0] -eq 'wrangler') {
            $rest = @()
            if ($Arguments.Length -gt 1) { $rest = $Arguments[1..($Arguments.Length - 1)] }
            & 'node_modules\.bin\wrangler.cmd' @rest
            return
        }
    }
    & npx @Arguments
}

# --- deploy config -----------------------------------------------------------
# `$ConfigFile` is generated, so there are two ways for it to be wrong: the
# generator cannot run (no ids file), or it ran and left placeholders behind (it
# cannot, but the check is cheap and this is the file that ships).
#
# The placeholders are read from the config rather than assumed, so a future
# third placeholder cannot slip past the deploy guard unnoticed.
function Get-Placeholders {
    if (-not (Test-Path $ConfigFile)) { return @() }
    $matches = Select-String -Path $ConfigFile -Pattern 'REPLACE_WITH_[A-Z0-9_]*' -AllMatches -ErrorAction SilentlyContinue
    $found = @()
    foreach ($m in $matches) {
        foreach ($mm in $m.Matches) { $found += $mm.Value }
    }
    return $found | Sort-Object -Unique
}

function Test-ConfigOk {
    return (Test-Path $ConfigFile) -and (Test-Path 'package.json')
}

# Regenerate `wrangler.local.jsonc` from the template + the local ids.
#
# Every wrangler action calls this first, so "the deploy config" has exactly one
# definition and a stale copy cannot be used by accident. The generator is
# idempotent: unchanged input means it does not rewrite the file, so this is
# cheap enough to run before every action.
function Invoke-EnsureConfig {
    Assert-Node
    if (-not (Test-Path $TemplateFile)) { Die "$TemplateFile missing — are you in the project root?" }
    $out = & node scripts/make-local-config.mjs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Write-Line "  $_" }
        Write-Err2 "could not generate $ConfigFile (see the message above)"
        return 3
    }
    if (-not (Test-Path $ConfigFile)) { Write-Err2 "$ConfigFile was not produced"; return 3 }
    return 0
}

# --- actions -----------------------------------------------------------------
# Every action prints a completion line so a caller tailing the log can tell
# "finished" from "died". That is the same rule the test suites follow
# (AGENTS.md: "no summary = failure") applied to the launcher.

function Invoke-Install {
    Assert-Node
    Write-Head 'npm install'
    & npm install
    return $LASTEXITCODE
}

function Invoke-Typecheck {
    Assert-Deps
    Write-Head 'tsc --noEmit'
    # `tsc` exits non-zero on the upstream lib.dom.d.ts / @cloudflare/workers-types
    # conflicts, which predate this repo and are not actionable here. AGENTS.md
    # states the bar as "0 errors under src/", so that is what this checks —
    # counting our own errors, not the toolchain's.
    $out = @(& 'node_modules\.bin\tsc.cmd' --noEmit 2>&1 | ForEach-Object { "$_" })
    $ours = @($out | Where-Object { $_ -match '^(src|scripts)/' })
    $total = @($out | Where-Object { $_ -match 'error TS' }).Count
    Write-Line ''
    if ($ours.Count -eq 0) {
        Write-Ok "typecheck clean under src/ (0 errors; $total upstream errors in node_modules ignored)"
        return 0
    }
    Write-Err2 "$($ours.Count) error(s) under src/ or scripts/:"
    $ours | Select-Object -First 25 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    return 1
}

function Invoke-Types {
    Assert-Deps
    Write-Head 'wrangler types (regenerate binding types)'
    Invoke-Npx wrangler types
    return $LASTEXITCODE
}

function Invoke-MigrateLocal {
    Assert-Deps
    $rc = Invoke-EnsureConfig
    if ($rc -ne 0) { return $rc }
    Write-Head 'apply migrations to the LOCAL database'
    Invoke-Npx wrangler d1 migrations apply $DbName --local -c $ConfigFile
    return $LASTEXITCODE
}

function Invoke-MigrateRemote {
    Assert-Deps
    $rc = Invoke-EnsureConfig
    if ($rc -ne 0) { return $rc }
    Write-Head 'apply migrations to the REMOTE database'
    Write-Warn2 'this touches the production D1 database'
    Invoke-Npx wrangler d1 migrations apply $DbName --remote -c $ConfigFile
    return $LASTEXITCODE
}

function Invoke-Dev {
    Assert-Deps
    $rc = Invoke-EnsureConfig
    if ($rc -ne 0) { return $rc }
    Write-Head "wrangler dev  ($DevUrl)"
    Write-Dim 'Ctrl-C to stop. First run: apply local migrations first (menu 2) or tables will be missing.'
    Write-Dim 'Bundled themes ship via Worker assets — syncing them into public/themes first.'
    $out = & node scripts/sync-bundled-themes.mjs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Write-Line "  $_" }
        return $LASTEXITCODE
    }
    Write-Line ''
    Invoke-Npx wrangler dev --port $DevPort --ip $DevHost -c $ConfigFile
    return $LASTEXITCODE
}

function Invoke-ThemeDeploy {
    param([string]$Theme = 'content/themes/default')
    Assert-Node
    if (-not (Test-Path $Theme)) { Die "theme directory not found: $Theme" }
    Write-Head "deploy theme: $Theme"
    Write-Dim "requires a running dev server at $DevUrl (menu 1)"
    & node scripts/deploy-theme.mjs $Theme $DevUrl
    return $LASTEXITCODE
}

function Invoke-Seed {
    Assert-Node
    Write-Head 'seed demo content'
    Write-Dim "requires a running dev server at $DevUrl (menu 1)"
    & node scripts/seed-demo-content.mjs
    return $LASTEXITCODE
}
# Binds the local test domains (from `sites.host`) inside a **marker block** of
# the system hosts file. The block is the only thing it touches, it backs the
# file up (and verifies the backup) before writing, and it is idempotent.
# Writing needs an elevated shell, so a permission failure exits 3 with the
# exact command to re-run rather than a silent half-success.
function Invoke-Hosts {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    Assert-Node
    Write-Head 'bind test domains in the hosts file'
    Write-Dim 'edits the system hosts file inside a marker block; backs up first'
    & node scripts/dev-hosts.mjs @Arguments
    return $LASTEXITCODE
}

# --- tests: one suite at a time ---------------------------------------------
# `npm test` is a single && chain, and in this sandbox spawnSync of the node
# binary fails with EBUSY (see AGENTS.md) — the whole chain then reports SKIP,
# which is easy to misread as "nothing to do". Running each suite as its own
# process avoids the spawn path entirely and, more importantly, lets one
# failing suite be reported as one failing suite.
#
# The verdict is parsed from the suite's own summary line, and a suite that
# never printed one counts as FAILED. "I could not tell" is not "it passed"
# (AGENTS.md, the sixth false green).
#
# `_schema-scope` is `_schema-scope.mjs`, not `_schema-scope.test.mjs`, so the
# file name comes from this table rather than from a convention that does not
# hold for all of them.
$Script:Suites = [ordered]@{
    'architecture'       = 'tests/suites/architecture.test.mjs'
    '_schema-scope'      = 'tests/tools/_schema-scope.mjs'
    'manifest-validation' = 'tests/suites/manifest-validation.test.mjs'
    'admin-menus'        = 'tests/suites/admin-menus.test.mjs'
    'admin-spa'          = 'tests/suites/admin-spa.test.mjs'
    'template-engine'    = 'tests/suites/template-engine.test.mjs'
    'scaffold'           = 'tests/suites/scaffold.test.mjs'
    'theme-integration'  = 'tests/suites/theme-integration.test.mjs'
    'locale-url'        = 'tests/suites/locale-url.test.mjs'
    'theme-fixture'      = 'tests/suites/theme-fixture.test.mjs'
    'theme-default'        = 'tests/suites/theme-default.test.mjs'
    'theme-bundled'      = 'tests/suites/theme-bundled.test.mjs'
    'multisite'          = 'tests/suites/multisite.test.mjs'
    'i18n'               = 'tests/suites/i18n.test.mjs'
    'admin-contract'     = 'tests/suites/admin-contract.test.mjs'
    'media'              = 'tests/suites/media.test.mjs'
    'media-picker'       = 'tests/suites/media-picker.test.mjs'
    'media-hosts'        = 'tests/suites/media-hosts.test.mjs'
    'editor-blocks'      = 'tests/suites/editor-blocks.test.mjs'
    'account'            = 'tests/suites/account.test.mjs'
    'menu-custom'        = 'tests/suites/menu-custom.test.mjs'
    'user-delete'        = 'tests/suites/user-delete.test.mjs'
    'multisite-matrix'   = 'tests/suites/multisite-isolation-matrix.test.mjs'
    'plugin-hooks'       = 'tests/suites/plugin-hooks.test.mjs'
    'plugin-channels'    = 'tests/suites/plugin-channels.test.mjs'
    'plugin-pages'       = 'tests/suites/plugin-pages.test.mjs'
    'theme-worker'       = 'tests/suites/theme-worker.test.mjs'
    'features'           = 'tests/suites/features.test.mjs'
    'permalink'          = 'tests/suites/permalink.test.mjs'
    'hook-tester'        = 'tests/suites/hook-tester.test.mjs'
    'shop-theme'         = 'tests/suites/shop-theme.test.mjs'
    'theme-assets'       = 'tests/suites/theme-assets.test.mjs'
    'api-keys'           = 'tests/suites/api-keys.test.mjs'
    'launcher-parity'    = 'tests/suites/launcher-parity.test.mjs'
}

function Invoke-OneSuite {
    param([string]$Name)

    if (-not $Script:Suites.Contains($Name)) {
        Write-Host ('{0,-24} {1}' -f $Name, "MISSING (unknown suite: $Name)")
        return $false
    }
    $file = $Script:Suites[$Name]
    if (-not (Test-Path $file)) {
        Write-Host ('{0,-24} {1}' -f $Name, "MISSING ($file)")
        return $false
    }

    # stderr is captured via a temp file rather than `2>&1`. In PowerShell 5.1
    # `2>&1` on a native command turns each stderr line into an ErrorRecord,
    # which pollutes the output and (with Stop) terminates the caller. A file
    # redirect is what cmd does natively and has neither problem.
    $tmpOut = [System.IO.Path]::GetTempFileName()
    $tmpErr = [System.IO.Path]::GetTempFileName()
    $out = ''
    $errText = ''
    try {
        & cmd /c "node `"$file`" > `"$tmpOut`" 2> `"$tmpErr`""
        $rc = $LASTEXITCODE
        if (Test-Path $tmpOut) { $out = [string](Get-Content $tmpOut -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path $tmpErr) { $errText = [string](Get-Content $tmpErr -Raw -ErrorAction SilentlyContinue) }
    } finally {
        Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
    $out = [string]$out
    # node's ExperimentalWarning for node:sqlite goes to stderr on every run;
    # drop that noise but keep anything else, because "silent stderr" is how a
    # suite that never started gets mistaken for a suite that passed.
    $errText = [string]$errText
    if ($errText.Trim()) {
        $errText = ($errText -split "`r?`n" | Where-Object { $_ -notmatch '(?i)^\(node:\d+\) (Experimental)?Warning' }) -join "`n"
        if ($errText.Trim()) { $out = "$out`n$errText" }
    }

    $summary = $null
    foreach ($line in ($out -split "`r?`n")) {
        if ($line -match '^\d+ passed, \d+ failed') { $summary = $line.Trim() }
    }

    if (-not $summary) {
        Write-Host ('{0,-24} {1}' -f $Name, 'FAILED (no summary line — suite aborted or crashed)') -ForegroundColor Red
        ($out -split "`r?`n" | Select-Object -Last 20) | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        return $false
    }

    if ($summary -match ', 0 failed') {
        Write-Host ('{0,-24} {1}  ok' -f $Name, $summary) -ForegroundColor Green
        return $true
    }

    Write-Host ('{0,-24} {1}  FAILED' -f $Name, $summary) -ForegroundColor Red
    ($out -split "`r?`n" | Where-Object { $_ -match '(?i)fail|error' } | Select-Object -First 12) |
        ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    return $false
}

function Invoke-Test {
    param([string]$Filter = '')

    Assert-Node
    Write-Head 'test suites (one process each)'

    if ($Filter -and $Filter -ne 'all') {
        if (Invoke-OneSuite $Filter) { return 0 } else { return 1 }
    }

    $total = 0; $bad = 0; $badNames = @()
    foreach ($name in $Script:Suites.Keys) {
        $total++
        if (-not (Invoke-OneSuite $name)) { $bad++; $badNames += $name }
    }

    Write-Line ''
    if ($bad -eq 0) {
        Write-Ok "$total suites, $bad failures"
        return 0
    }
    Write-Err2 "$total suites, $bad failures: $($badNames -join ' ')"
    return 1
}

function Invoke-Audit {
    Assert-Node
    Write-Head 'tenant scope declarations vs the real database'
    & node tests/tools/_schema-scope.mjs
    $a = $LASTEXITCODE
    Write-Head 'query-level tenant audit (report-only)'
    & node tests/tools/_tenant-query-audit.mjs
    $b = $LASTEXITCODE
    Write-Head 'settings keys are declared (two-level settings)'
    & node tests/tools/_setting-keys.mjs
    $c = $LASTEXITCODE
    Write-Head 'no behaviour pinned to one language'
    & node tests/tools/_locale-literal.mjs
    $d = $LASTEXITCODE
    if ($a -eq 0 -and $b -eq 0 -and $c -eq 0 -and $d -eq 0) { return 0 } else { return 1 }
}

function Invoke-Make {
    param([string]$Kind, [string]$Name)
    Assert-Node
    if ($Kind -notin @('theme', 'plugin', 'table')) { Die 'usage: cfpress.ps1 make (theme|plugin|table) (name)' }
    if (-not $Name) { Die 'usage: cfpress.ps1 make (theme|plugin|table) (name)' }
    Write-Head "scaffold: $Kind $Name"
    & node "scripts/make-$Kind.mjs" $Name
    return $LASTEXITCODE
}

# --- deploy ------------------------------------------------------------------
# Refusing is the point. `wrangler deploy` with REPLACE_WITH_D1_DATABASE_ID in
# the config does not fail loudly — it produces a Worker whose DB binding points
# nowhere, and the first symptom is a 500 on a URL you already announced. So the
# placeholder check runs before deploy, not after.
#
# WARNING: the ids go in `$IdsFile`, never in `$TemplateFile`. An earlier version
# of this message told the operator to edit the committed template, which is
# tracked by git — following that advice published a live database id to a
# public repository on the next commit.
function Test-DeployPrecheck {
    Assert-Deps
    $rc = Invoke-EnsureConfig
    if ($rc -ne 0) { return $false }
    if (-not (Test-ConfigOk)) { Die "missing $ConfigFile or package.json — are you in the project root?" }

    $missing = @(Get-Placeholders)
    if ($missing.Count -gt 0) {
        Write-Err2 "refusing to deploy: $ConfigFile still contains placeholder ids"
        Write-Line ''
        foreach ($m in $missing) { Write-Line "    $m" }
        Write-Line ''
        Write-Line "  This file is generated. Put the real ids in ${IdsFile}:"
        Write-Line ''
        Write-Line "    npx wrangler d1 create $DbName        # -> database_id"
        Write-Line '    npx wrangler kv namespace create CACHE # -> id'
        Write-Line ''
        Write-Line "  $IdsFile is gitignored; $TemplateFile is not, so never edit ids into it."
        Write-Line '  Then re-run. To deploy anyway: .\scripts\cfpress.ps1 deploy --force'
        return $false
    }
    return $true
}

function Invoke-Deploy {
    param([switch]$Force)
    if (-not $Force) {
        if (-not (Test-DeployPrecheck)) { return 3 }
    }
    Assert-Deps
    $rc = Invoke-EnsureConfig
    if ($rc -ne 0) { return $rc }
    Write-Head 'sync bundled themes (content/themes -> public/themes assets)'
    & node scripts/sync-bundled-themes.mjs
    if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
    Write-Head 'wrangler deploy'
    Invoke-Npx wrangler deploy -c $ConfigFile
    return $LASTEXITCODE
}

function Invoke-DeployFull {
    param([switch]$Force)
    if (-not $Force) {
        if (-not (Test-DeployPrecheck)) { return 3 }
    }
    $rc = Invoke-MigrateRemote
    if ($rc -ne 0) { return $rc }
    return (Invoke-Deploy)
}

# --- diagnostics -------------------------------------------------------------
function Invoke-Doctor {
    Write-Head 'doctor'

    $nodeLine = 'not found'
    if (Test-Command 'node') { $nodeLine = (& node --version) }
    Write-Line "  node       $nodeLine"
    Write-Line "  cwd        $Root"

    if (Test-Command 'npm') { Write-Line "  npm        $(& npm --version)" } else { Write-Line '  npm        not found' }

    if (Test-Path 'node_modules') { Write-Line '  deps       node_modules present' }
    else { Write-Warn2 'deps       node_modules MISSING — run: cfpress.ps1 install' }

    if (Test-Path 'node_modules\wrangler\package.json') {
        try {
            $wv = (Get-Content 'node_modules\wrangler\package.json' -Raw | ConvertFrom-Json).version
            Write-Line "  wrangler   $wv (local)"
        } catch { Write-Line '  wrangler   (version unreadable)' }
    } else { Write-Warn2 'wrangler   not installed locally' }

    # The config is derived, so report all three links in the chain: a missing
    # ids file and a stale generated file look identical from the outside (both
    # mean "the commands are not using what you think"), and only naming them
    # apart tells you which one to fix.
    if (Test-Path $TemplateFile) { Write-Line "  template   $TemplateFile (committed, placeholders)" }
    else { Write-Warn2 "template   $TemplateFile MISSING" }
    if (Test-Path $IdsFile) { Write-Line "  ids        $IdsFile present" }
    else { Write-Warn2 "ids        $IdsFile MISSING — generate it before dev/deploy" }

    if (Test-Path $ConfigFile) {
        Write-Line "  config     $ConfigFile present"
        $ph = @(Get-Placeholders)
        if ($ph.Count -gt 0) { Write-Warn2 "config     placeholders still present: $($ph -join ' ')" }
        else { Write-Line '  config     no REPLACE_WITH_ placeholders' }
    } else { Write-Warn2 "config     $ConfigFile MISSING" }

    # Was `site\migrations`, a directory that has not existed since the tree was
    # reorganised — so this line reported "0 file(s)" next to the shell
    # launcher's 18 and nothing compared the two. A doctor that under-reports
    # is worse than no doctor: it reads as "nothing to migrate".
    $n = @(Get-ChildItem 'content\migrations\*.sql' -ErrorAction SilentlyContinue).Count
    Write-Line "  migrations $n file(s)"
    $s = @(Get-ChildItem 'tests\suites\*.test.mjs' -ErrorAction SilentlyContinue).Count
    Write-Line "  suites     $s test suite(s)"

    if (Test-Command 'git') {
        $sha = (& git rev-parse --short HEAD 2>$null)
        $br  = (& git rev-parse --abbrev-ref HEAD 2>$null)
        Write-Line "  git        $sha $br"
    }

    # The dev-server probe is the one check that can hang on a slow machine, so
    # it gets a short timeout and its failure is informational, never fatal.
    try {
        $null = Invoke-WebRequest -Uri $DevUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        Write-Ok "dev server responding at $DevUrl"
    } catch {
        Write-Dim "dev server not responding at $DevUrl (not running?)"
    }
    return 0
}

function Invoke-Version {
    Write-Head 'cfpress launcher'
    try {
        $pv = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
        Write-Line "  project   $pv"
    } catch { Write-Line '  project   ?' }
    Write-Line "  config    $ConfigFile  (generated from $TemplateFile + $IdsFile)"
    Write-Line "  dev url   $DevUrl"
    Write-Line "  root      $Root"
    if (Test-Command 'git') {
        $sha = (& git rev-parse HEAD 2>$null)
        Write-Line "  commit    $sha"
        $dirty = @(& git status --porcelain 2>$null).Count
        if ($dirty -eq 0) { Write-Line '  worktree  clean' } else { Write-Line "  worktree  $dirty changed file(s)" }
    }
    return 0
}

function Write-Help {
    $suiteNames = ($Script:Suites.Keys) -join '  '
    Write-Line @"

CFPress launcher  (repo root: $Root)

  USAGE / 用法
    .\scripts\cfpress.ps1                    numeric menu / 数字交互菜单
    .\scripts\cfpress.ps1 (action) [args]    run one action and exit / 命令模式

  ACTIONS / 动作
    dev                 start the local dev server / 启动本地服务 (menu 1)
    migrate:local       apply migrations to the local D1 / 本地迁移 (menu 2)
    config              regenerate wrangler.local.jsonc / 生成部署配置
    theme [dir]         upload + activate a theme / 部署主题 (menu 3)
    seed                seed demo content / 灌演示数据
    hosts (cmd)         bind test domains in the hosts file / 绑定测试域名
    test [suite]        run every suite, or one by name / 跑测试 (menu 4)
    typecheck           tsc --noEmit / 类型检查 (menu 5)
    types               regenerate worker-configuration.d.ts / 重新生成绑定类型
    audit               schema-scope + tenant query audit / 租户·语言审计 (menu 6)
    make (kind) (name)  scaffold a theme, plugin or table / 生成骨架
    migrate:remote      apply migrations to production D1 / 远程迁移
    deploy [-Force]     deploy the Worker / 部署 (menu 7)
    deploy:full         remote migrations, then deploy / 部署+远程迁移 (menu 8)
    doctor              environment report / 诊断环境 (menu 9)
    install             npm install / 安装依赖
    version             version and git state / 版本与 git 状态
    help                this text / 本帮助

  SUITES / 套件名  (for "test (name)" / 用于 test (name))
    $suiteNames

  ENV / 环境变量
    CFP_PORT (default 47913)  CFP_HOST (default 127.0.0.1)   NO_COLOR (disable colour)

  EXIT CODES / 退出码
    0 ok    1 failed/aborted    2 usage error    3 refused by a precondition

"@
}

# --- interactive menu --------------------------------------------------------
function Show-Menu {
    Write-Line ''
    Write-Host '┌──────────────────────────────────────────────┐' -ForegroundColor DarkCyan
    Write-Host "│  CFPress  $Root" -ForegroundColor DarkCyan
    Write-Host '├──────────────────────────────────────────────┤' -ForegroundColor DarkCyan
    Write-Host "│  1) 启动本地服务   dev (port $DevPort)"
    Write-Host '│  2) 本地数据库迁移  migrate --local'
    Write-Host '│  3) 部署主题        theme deploy'
    Write-Host '│  4) 跑全部测试      test (per suite)'
    Write-Host '│  5) 类型检查        tsc --noEmit'
    Write-Host '│  6) 租户/语言审计   audit'
    Write-Host '│  7) 部署            deploy'
    Write-Host '│  8) 部署+远程迁移   deploy:full'
    Write-Host '│  9) 诊断环境        doctor'
    Write-Host '└──────────────────────────────────────────────┘' -ForegroundColor DarkCyan
    Write-Dim '  other:  t2 (name) 单套件 · mk (theme|plugin|table) (name) · cfg 生成部署配置 · v 版本 · h 帮助 · q 退出'
}

function Read-MenuInput {
    param([string]$Prompt)
    # Read-Host reads the console, not the pipeline, so `echo 4 | cfpress.ps1`
    # cannot feed the menu a file of answers by accident. The flip side is that
    # with no console it returns nothing — and a loop that treats "no answer" as
    # "ask again" spins forever writing menu frames. So when there is nothing to
    # read from either source, signal end-of-input and let the loop stop.
    if (-not $Host.UI.RawUI) { return $null }
    if ([Console]::IsInputRedirected -and -not [Console]::In.Peek()) { return $null }
    try {
        return (Read-Host $Prompt)
    } catch {
        return $null
    }
}

function Confirm-Yes {
    param([string]$Prompt)
    $a = Read-MenuInput $Prompt
    return ($a -match '^(?i)y')
}

function Start-MenuLoop {
    # `printf '9\nq\n' | cfpress.ps1` is how a check drives this menu. When the
    # input runs out the loop ends — "no more input" is not "ask again", and
    # treating it as such produces an unbounded stream of menu frames.
    while ($true) {
        Show-Menu
        $choice = Read-MenuInput '  > '
        if ($null -eq $choice) {
            Write-Line ''
            Write-Dim '  (end of input — leaving the menu)'
            return 0
        }
        switch -Regex ($choice.Trim()) {
            '^1$' { Invoke-Dev }
            '^2$' { Invoke-MigrateLocal }
            '^3$' {
                $t = Read-MenuInput '  theme dir [content/themes/default]: '
                if (-not $t) { $t = 'content/themes/default' }
                Invoke-ThemeDeploy $t
            }
            '^4$' { Invoke-Test }
            '^5$' { Invoke-Typecheck }
            '^6$' { Invoke-Audit }
            '^7$' {
                if (Confirm-Yes '  confirm deploy to production? [y/N] ') { Invoke-Deploy }
                else { Write-Warn2 'aborted.' }
            }
            '^8$' {
                if (Confirm-Yes '  confirm deploy + remote migrations? [y/N] ') { Invoke-DeployFull }
                else { Write-Warn2 'aborted.' }
            }
            '^9$' { Invoke-Doctor }
            '^cfg$|^config$' { Invoke-EnsureConfig }
            '^v$' { Invoke-Version }
            '^h$|^help$|^$|^\?$' { Write-Help }
            '^q$|^quit$|^exit$' { Write-Line 'bye.'; return 0 }
            '^t2\s+(\S+)$' { Invoke-Test $Matches[1] }
            '^mk\s+(\S+)\s+(\S+)$' { Invoke-Make $Matches[1] $Matches[2] }
            default { Write-Warn2 "unknown choice: $choice" }
        }
    }
}

# --- dispatch ----------------------------------------------------------------
function Invoke-Action {
    param([string]$Name, [string[]]$Extra)

    $force = $false
    foreach ($e in $Extra) { if ($e -match '^(?i)-?-?force$') { $force = $true } }
    $first = ''
    if ($Extra.Count -gt 0) { $first = $Extra[0] }

    switch ($Name) {
        'help'        { Write-Help; return 0 }
        '-h'          { Write-Help; return 0 }
        '--help'      { Write-Help; return 0 }
        'version'     { return (Invoke-Version) }
        '-v'          { return (Invoke-Version) }
        '--version'   { return (Invoke-Version) }
        'dev'         { return (Invoke-Dev) }
        'config'      { return (Invoke-EnsureConfig) }
        'migrate:local'  { return (Invoke-MigrateLocal) }
        'migrate-local'  { return (Invoke-MigrateLocal) }
        'migrate:remote' { return (Invoke-MigrateRemote) }
        'migrate-remote' { return (Invoke-MigrateRemote) }
        'theme'          { return (Invoke-ThemeDeploy $first) }
        'theme:deploy'   { return (Invoke-ThemeDeploy $first) }
        'seed'           { return (Invoke-Seed) }
        'seed:demo'      { return (Invoke-Seed) }
        'hosts'          { return (Invoke-Hosts @Extra) }
        'test'           { return (Invoke-Test $first) }
        'test:all'       { return (Invoke-Test) }
        'typecheck'      { return (Invoke-Typecheck) }
        'types'          { return (Invoke-Types) }
        'audit'          { return (Invoke-Audit) }
        'install'        { return (Invoke-Install) }
        'doctor'         { return (Invoke-Doctor) }
        'make'           { return (Invoke-Make $Extra[0] $Extra[1]) }
        'make:theme'     { return (Invoke-Make 'theme' $first) }
        'make:plugin'    { return (Invoke-Make 'plugin' $first) }
        'make:table'     { return (Invoke-Make 'table' $first) }
        'deploy'         { return (Invoke-Deploy -Force:$force) }
        'deploy:full'    { return (Invoke-DeployFull -Force:$force) }
        'deploy-full'    { return (Invoke-DeployFull -Force:$force) }
        default { Die "unknown action `"$Name`" — run: .\scripts\cfpress.ps1 help" }
    }
}

if (-not $Action) {
    exit (Start-MenuLoop)
}

$rc = Invoke-Action $Action $Args
if ($rc -eq $null) { $rc = 0 }
exit $rc
