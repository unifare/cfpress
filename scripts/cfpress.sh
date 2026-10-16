#!/usr/bin/env sh
#
# cfpress.sh — CFPress launcher (POSIX sh)
#
# Two ways in, one set of actions:
#
#   ./scripts/cfpress.sh                 numeric menu, loops until you exit
#   ./scripts/cfpress.sh dev             command mode, one action, exits
#   ./scripts/cfpress.sh test --filter tenant   command mode with arguments
#
# The menu and the command mode call the same `run_*` functions. There is no
# second implementation of "deploy" hiding in the menu branch — a launcher whose
# menu and CLI can drift apart is two launchers, and only one of them gets
# tested.
#
# Exit codes
#   0  the action succeeded (or ran and reported failures the caller can read)
#   1  the action failed, or the user aborted
#   2  usage error — unknown action, bad argument, missing prerequisite
#   3  refused on a precondition the user can fix (see deploy)
#
# Written for `sh`, not bash: no arrays, no `[[`, no `${var^^}`. It runs under
# dash, busybox ash, and Git Bash alike — this repo is developed on Windows but
# deployed from Linux, and a launcher that only works on one of them is a
# launcher half the team cannot use.

set -u

# --- locate the project root -------------------------------------------------
# Scripts may be invoked from anywhere; every command must run from the repo
# root because wrangler.jsonc, migrations/ and node_modules/ are all relative.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT" || { echo "cannot cd to $ROOT" >&2; exit 2; }

# The generated deploy config, and the two files it is derived from.
#
# `CONFIG` is what every wrangler command below is pointed at with `-c`. It is
# NOT the committed file: `wrangler.jsonc` carries REPLACE_WITH_* placeholders
# so a public clone never publishes account-scoped ids, and the real values live
# in `wrangler.ids.json` (gitignored). `ensure_config` below runs the generator
# that joins them.
#
# ⚠️ This used to be `CONFIG="wrangler.jsonc"` with `wrangler deploy` given no
# `-c` at all, and the refusal message told the operator to *edit the committed
# template* with their real ids. That is a leak: `wrangler.jsonc` is tracked, so
# the next `git commit -a` publishes the ids of a live database. The two files
# were also free to drift, and did — batch 11 put the feature-switch `vars`
# block in the template only, so the deployed Worker had no `vars` at all.
CONFIG="wrangler.local.jsonc"
TEMPLATE="wrangler.jsonc"
IDS="wrangler.ids.json"
DB_NAME="cfpress"
# Deliberately an uncommon port. 8787 is the default for `wrangler dev`, so it
# collides with every other Wrangler project on the machine (and with the two
# wrangler dev instances that cause SQLITE_BUSY). 47913 is in the private range
# and is not the default of any tool we use. Override with CFP_PORT.
DEV_PORT="${CFP_PORT:-47913}"
DEV_HOST="${CFP_HOST:-127.0.0.1}"

# --- output helpers ----------------------------------------------------------
# No colour when stdout is not a terminal, so piping the launcher into a log
# file produces a log without escape codes in it. `+x` rather than `-z` so that
# a bare `NO_COLOR=` (empty but present, which is how the convention specifies
# it) also disables colour instead of being read as "unset".
if [ -t 1 ] && [ -z "${NO_COLOR+x}" ]; then
  C_RESET=$(printf '\033[0m'); C_DIM=$(printf '\033[2m')
  C_BOLD=$(printf '\033[1m'); C_RED=$(printf '\033[31m')
  C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m')
  C_BLUE=$(printf '\033[34m')
else
  C_RESET=; C_DIM=; C_BOLD=; C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=
fi

say()  { printf '%s\n' "$*"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
head1() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '%s  ok  %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s  !!  %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
err()  { printf '%s  XX  %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; }

die() { err "$*"; exit 2; }

# --- prerequisites -----------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

require_node() {
  have node || die "node not found on PATH — install Node.js 20+ first"
}

require_deps() {
  [ -d node_modules ] || die "node_modules/ missing — run: npm install (or: $0 install)"
  [ -f "node_modules/.bin/wrangler" ] || die "wrangler missing — run: npm install (or: $0 install)"
}

require_wrangler() { require_node; require_deps; }

# --- deploy config -----------------------------------------------------------
# `CONFIG` is generated, so there are two ways for it to be wrong: the generator
# cannot run (no ids file), or it ran and left placeholders behind (it cannot,
# but the check is cheap and this is the file that ships).
#
# The placeholders are read from the config rather than assumed, so a future
# third placeholder cannot slip past the deploy guard unnoticed.
placeholders_found() {
  [ -f "$CONFIG" ] || return 0
  grep -o 'REPLACE_WITH_[A-Z0-9_]*' "$CONFIG" 2>/dev/null | sort -u
}

config_ok() {
  [ -f "$CONFIG" ] && [ -f "package.json" ]
}

# Regenerate `wrangler.local.jsonc` from the template + the local ids.
#
# Every wrangler action calls this first, so "the deploy config" has exactly one
# definition and a stale copy cannot be used by accident. The generator is
# idempotent: unchanged input means it does not rewrite the file, so this is
# cheap enough to run before every action.
ensure_config() {
  require_node
  [ -f "$TEMPLATE" ] || die "$TEMPLATE missing — are you in the project root?"
  node scripts/make-local-config.mjs || {
    err "could not generate $CONFIG (see the message above)"
    return 3
  }
  [ -f "$CONFIG" ] || { err "$CONFIG was not produced"; return 3; }
  return 0
}

# --- actions -----------------------------------------------------------------
# Every action prints a completion line so a caller tailing the log can tell
# "finished" from "died". That is the same rule the test suites follow
# (AGENTS.md: "no summary = failure") applied to the launcher.

act_install() {
  require_node
  head1 "npm install"
  npm install
}

act_typecheck() {
  require_deps
  head1 "tsc --noEmit"
  # `tsc` exits non-zero on the upstream lib.dom.d.ts / @cloudflare/workers-types
  # conflicts, which predate this repo and are not actionable here. AGENTS.md
  # states the bar as "0 errors under src/", so that is what this checks —
  # counting our own errors, not the toolchain's.
  out=$(npx --no-install tsc --noEmit 2>&1)
  ours=$(printf '%s\n' "$out" | grep -E '^(src|scripts)/' | wc -l | tr -d ' ')
  total=$(printf '%s\n' "$out" | grep -cE 'error TS' | tr -d ' ')
  say ""
  if [ "$ours" -eq 0 ]; then
    ok "typecheck clean under src/ (0 errors; $total upstream errors in node_modules ignored)"
    return 0
  fi
  err "$ours error(s) under src/ or scripts/:"
  printf '%s\n' "$out" | grep -E '^(src|scripts)/' | head -25 | sed 's/^/      /'
  return 1
}

act_types() {
  require_wrangler
  head1 "wrangler types (regenerate binding types)"
  npx --no-install wrangler types
}

act_migrate_local() {
  require_wrangler
  ensure_config || return $?
  head1 "apply migrations to the LOCAL database"
  npx --no-install wrangler d1 migrations apply "$DB_NAME" --local -c "$CONFIG"
}

act_migrate_remote() {
  require_wrangler
  ensure_config || return $?
  head1 "apply migrations to the REMOTE database"
  warn "this touches the production D1 database"
  npx --no-install wrangler d1 migrations apply "$DB_NAME" --remote -c "$CONFIG"
}

act_dev() {
  require_wrangler
  ensure_config || return $?
  head1 "wrangler dev  (http://$DEV_HOST:$DEV_PORT)"
  dim "Ctrl-C to stop. First run: apply local migrations first (menu 2) or tables will be missing."
  dim "Bundled themes ship via Worker assets — sync them into public/themes first."
  node scripts/sync-bundled-themes.mjs || return $?
  say ""
  exec npx --no-install wrangler dev --port "$DEV_PORT" --ip "$DEV_HOST" -c "$CONFIG"
}

act_theme_deploy() {
  require_wrangler
  theme="${1:-content/themes/default}"
  [ -d "$theme" ] || die "theme directory not found: $theme"
  head1 "deploy theme: $theme"
  dim "requires a running dev server at http://$DEV_HOST:$DEV_PORT (menu 1)"
  node scripts/deploy-theme.mjs "$theme" "http://$DEV_HOST:$DEV_PORT"
}

act_seed() {
  require_wrangler
  head1 "seed demo content"
  dim "requires a running dev server at http://$DEV_HOST:$DEV_PORT (menu 1)"
  node scripts/seed-demo-content.mjs
}

# Binds the local test domains (from `sites.host`) inside a **marker block** of
# the system hosts file. The block is the only thing it touches, it backs the
# file up (and verifies the backup) before writing, and it is idempotent.
# Writing needs an elevated shell, so a permission failure exits 3 with the
# exact command to re-run rather than a silent half-success.
act_hosts() {
  require_node
  head1 "bind test domains in the hosts file"
  dim "edits the system hosts file inside a marker block; backs it up first"
  node scripts/dev-hosts.mjs "$@"
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
SUITES="architecture|tests/suites/architecture.test.mjs
_schema-scope|tests/tools/_schema-scope.mjs
manifest-validation|tests/suites/manifest-validation.test.mjs
admin-menus|tests/suites/admin-menus.test.mjs
admin-spa|tests/suites/admin-spa.test.mjs
template-engine|tests/suites/template-engine.test.mjs
scaffold|tests/suites/scaffold.test.mjs
theme-integration|tests/suites/theme-integration.test.mjs
locale-url|tests/suites/locale-url.test.mjs
theme-fixture|tests/suites/theme-fixture.test.mjs
theme-default|tests/suites/theme-default.test.mjs
theme-bundled|tests/suites/theme-bundled.test.mjs
multisite|tests/suites/multisite.test.mjs
i18n|tests/suites/i18n.test.mjs
admin-contract|tests/suites/admin-contract.test.mjs
media|tests/suites/media.test.mjs
media-picker|tests/suites/media-picker.test.mjs
media-hosts|tests/suites/media-hosts.test.mjs
editor-blocks|tests/suites/editor-blocks.test.mjs
account|tests/suites/account.test.mjs
menu-custom|tests/suites/menu-custom.test.mjs
user-delete|tests/suites/user-delete.test.mjs
multisite-matrix|tests/suites/multisite-isolation-matrix.test.mjs
plugin-hooks|tests/suites/plugin-hooks.test.mjs
plugin-channels|tests/suites/plugin-channels.test.mjs
plugin-pages|tests/suites/plugin-pages.test.mjs
theme-worker|tests/suites/theme-worker.test.mjs
features|tests/suites/features.test.mjs
permalink|tests/suites/permalink.test.mjs
hook-tester|tests/suites/hook-tester.test.mjs
shop-theme|tests/suites/shop-theme.test.mjs
theme-assets|tests/suites/theme-assets.test.mjs
api-keys|tests/suites/api-keys.test.mjs

launcher-parity|tests/suites/launcher-parity.test.mjs"

# `_schema-scope` is `tools/_schema-scope.mjs`, not `suites/_schema-scope.test.mjs`
# — the underscore marks it as tooling, and tooling that also runs in CI still has
# to be findable by name. So the file comes from the table above rather than from a
# `suites/<name>.test.mjs` convention that does not hold for all of them.
suite_file() {
  printf '%s\n' "$SUITES" | while IFS='|' read -r n f; do
    [ "$n" = "$1" ] && printf '%s\n' "$f"
  done
}

suite_names() { printf '%s\n' "$SUITES" | while IFS='|' read -r n f; do printf '%s\n' "$n"; done; }

run_one_suite() {
  name="$1"
  file=$(suite_file "$name")
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    printf '%-24s %s\n' "$name" "MISSING (${file:-unknown suite: $name})"
    return 1
  fi
  out=$(node "$file" 2>&1)
  rc=$?
  summary=$(printf '%s\n' "$out" | grep -E '^[0-9]+ passed, [0-9]+ failed' | tail -1)
  if [ -z "$summary" ]; then
    printf '%-24s %s\n' "$name" "FAILED (no summary line — suite aborted or crashed)"
    printf '%s\n' "$out" | tail -20 | sed 's/^/      /'
    return 1
  fi
  case "$summary" in
    *", 0 failed"*|*" 0 failed"*)
      printf '%-24s %s\n' "$name" "$summary  ok"
      return 0
      ;;
    *)
      printf '%-24s %s\n' "$name" "$summary  FAILED"
      printf '%s\n' "$out" | grep -iE 'FAIL|Error' | head -12 | sed 's/^/      /'
      return 1
      ;;
  esac
}

act_test() {
  require_node
  filter="${1:-}"
  head1 "test suites (one process each)"
  [ "$filter" = "all" ] && filter=""
  if [ -n "$filter" ]; then
    run_one_suite "$filter"
    return $?
  fi

  total=0; bad=0; badnames=""
  for name in $(suite_names); do
    total=$((total + 1))
    if ! run_one_suite "$name"; then
      bad=$((bad + 1))
      badnames="$badnames $name"
    fi
  done

  say ""
  if [ "$bad" -eq 0 ]; then
    ok "$total suites, $bad failures"
    return 0
  fi
  err "$total suites, $bad failures:$badnames"
  return 1
}

act_audit() {
  require_node
  head1 "tenant scope declarations vs the real database"
  node tests/tools/_schema-scope.mjs
  a=$?
  head1 "query-level tenant audit (report-only)"
  node tests/tools/_tenant-query-audit.mjs
  b=$?
  head1 "settings keys are declared (two-level settings)"
  node tests/tools/_setting-keys.mjs
  c=$?
  head1 "no behaviour pinned to one language"
  node tests/tools/_locale-literal.mjs
  d=$?
  [ "$a" -eq 0 ] && [ "$b" -eq 0 ] && [ "$c" -eq 0 ] && [ "$d" -eq 0 ]
}

act_make() {
  require_node
  kind="${1:-}"
  name="${2:-}"
  case "$kind" in
    theme|plugin|table) ;;
    *) die "usage: $0 make <theme|plugin|table> <name>" ;;
  esac
  [ -n "$name" ] || die "usage: $0 make <theme|plugin|table> <name>"
  head1 "scaffold: $kind $name"
  node "scripts/make-$kind.mjs" "$name"
}

# --- deploy ------------------------------------------------------------------
# Refusing is the point. `wrangler deploy` with REPLACE_WITH_D1_DATABASE_ID in
# the config does not fail loudly — it produces a Worker whose DB binding points
# nowhere, and the first symptom is a 500 on a URL you already announced. So the
# placeholder check runs before deploy, not after.
#
# ⚠️ The ids go in `wrangler.ids.json`, never in `$TEMPLATE`. An earlier version
# of this message told the operator to edit the committed template, which is
# tracked by git — following that advice published a live database id to a
# public repository on the next commit.
deploy_precheck() {
  require_wrangler
  ensure_config || return $?
  if ! config_ok; then
    die "missing $CONFIG or package.json — are you in the project root?"
  fi
  missing=$(placeholders_found)
  if [ -n "$missing" ]; then
    err "refusing to deploy: $CONFIG still contains placeholder ids"
    say ""
    for m in $missing; do say "    $m"; done
    say ""
    say "  This file is generated. Put the real ids in $IDS:"
    say ""
    say "    npx wrangler d1 create $DB_NAME        # -> database_id"
    say "    npx wrangler kv namespace create CACHE # -> id"
    say ""
    say "  $IDS is gitignored; $TEMPLATE is not, so never edit ids into it."
    say "  Then re-run. To deploy anyway: $0 deploy --force"
    return 3
  fi
  return 0
}

act_deploy() {
  force="${1:-}"
  if [ "$force" != "--force" ]; then
    deploy_precheck || return $?
  fi
  require_wrangler
  ensure_config || return $?
  head1 "sync bundled themes (content/themes -> public/themes assets)"
  node scripts/sync-bundled-themes.mjs || return $?
  head1 "wrangler deploy"
  npx --no-install wrangler deploy -c "$CONFIG"
}

act_deploy_full() {
  force="${1:-}"
  extra=""
  [ "$force" = "--force" ] && extra="--force"
  if [ "$force" != "--force" ]; then
    deploy_precheck || return $?
  fi
  act_migrate_remote || return $?
  act_deploy "$extra"
}

# --- diagnostics -------------------------------------------------------------
act_doctor() {
  head1 "doctor"
  node_line="not found"
  if have node; then node_line=$(node --version 2>&1); fi
  say "  node       $node_line"
  say "  cwd        $ROOT"

  if have npm; then say "  npm        $(npm --version 2>&1)"; else say "  npm        not found"; fi

  if [ -d node_modules ]; then say "  deps       node_modules present"; else warn "deps       node_modules MISSING — run: $0 install"; fi

  if [ -f "node_modules/wrangler/package.json" ]; then
    wv=$(node -p "require('./node_modules/wrangler/package.json').version" 2>/dev/null || echo "?")
    say "  wrangler   $wv (local)"
  else
    warn "wrangler   not installed locally"
  fi

  # The config is derived, so report all three links in the chain: a missing ids
  # file and a stale generated file look identical from the outside (both mean
  # "the commands are not using what you think"), and only naming them apart
  # tells you which one to fix.
  if [ -f "$TEMPLATE" ]; then
    say "  template   $TEMPLATE (committed, placeholders)"
  else
    warn "template   $TEMPLATE MISSING"
  fi
  if [ -f "$IDS" ]; then
    say "  ids        $IDS present"
  else
    warn "ids        $IDS MISSING — generate it before dev/deploy"
  fi
  if [ -f "$CONFIG" ]; then
    say "  config     $CONFIG present"
    ph=$(placeholders_found)
    if [ -n "$ph" ]; then
      warn "config     placeholders still present: $(printf '%s' "$ph" | tr '\n' ' ')"
    else
      say "  config     no REPLACE_WITH_ placeholders"
    fi
  else
    warn "config     $CONFIG MISSING"
  fi

  n=$(ls content/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
  say "  migrations $n file(s)"
  s=$(ls tests/suites/*.test.mjs 2>/dev/null | wc -l | tr -d ' ')
  say "  suites     $s test suite(s)"

  if have git; then
    say "  git        $(git rev-parse --short HEAD 2>/dev/null || echo '-') $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  fi

  if have curl; then
    if curl -s -o /dev/null -m 2 "http://$DEV_HOST:$DEV_PORT/" 2>/dev/null; then
      ok "dev server responding at http://$DEV_HOST:$DEV_PORT"
    else
      dim "dev server not responding at http://$DEV_HOST:$DEV_PORT (not running?)"
    fi
  fi
  return 0
}

act_version() {
  head1 "cfpress launcher"
  say "  project   $(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
  say "  config    $CONFIG  ${C_DIM}(generated from $TEMPLATE + $IDS)${C_RESET}"
  say "  dev url   http://$DEV_HOST:$DEV_PORT"
  say "  root      $ROOT"
  if have git; then
    say "  commit    $(git rev-parse HEAD 2>/dev/null || echo '-')"
    dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    [ "$dirty" = "0" ] && say "  worktree  clean" || say "  worktree  $dirty changed file(s)"
  fi
  return 0
}

act_help() {
  cat <<EOF

${C_BOLD}CFPress launcher${C_RESET}  ${C_DIM}(repo root: $ROOT)${C_RESET}

  ${C_BOLD}USAGE${C_RESET}
    ./scripts/cfpress.sh                    numeric menu (interactive)
    ./scripts/cfpress.sh <action> [args]    run one action and exit

  ${C_BOLD}ACTIONS${C_RESET}
    dev                 start the local dev server (menu 1)
    migrate:local       apply migrations to the local D1 (menu 2)
    config              regenerate wrangler.local.jsonc from wrangler.ids.json
    theme [dir]         upload + activate a theme on the running dev server
    seed                seed demo content on the running dev server
    hosts <cmd>         bind test domains in the hosts file (list/add/remove/verify)
    test [suite]        run every suite, or one by name (menu 4)
    typecheck           tsc --noEmit (menu 5)
    types               regenerate worker-configuration.d.ts
    audit               schema-scope + tenant query audit
    make <kind> <name>  scaffold a theme, plugin or table
    migrate:remote      apply migrations to production D1
    deploy [--force]    deploy the Worker (menu 7)
    deploy:full         remote migrations, then deploy (menu 8)
    doctor              environment report
    install             npm install
    version             version and git state
    help                this text

  ${C_BOLD}SUITES${C_RESET}  ${C_DIM}(for \`test <name>\`)${C_RESET}
    architecture  _schema-scope  manifest-validation  admin-menus  admin-spa
    template-engine  scaffold  theme-integration  theme-fixture  theme-default  theme-bundled  multisite  i18n
    admin-contract  account  menu-custom  plugin-hooks  plugin-channels  plugin-pages  theme-worker

  ${C_BOLD}ENV${C_RESET}
    CFP_PORT (default 47913)  CFP_HOST (default 127.0.0.1)   NO_COLOR (disable colour)

  ${C_BOLD}EXIT CODES${C_RESET}
    0 ok    1 failed/aborted    2 usage error    3 refused by a precondition

EOF
}

# --- interactive menu --------------------------------------------------------
# Reads from stdin when stdin is readable — including when it is a pipe, so
# `printf '9\nq\n' | ./scripts/cfpress.sh` drives the menu and the launcher can
# be exercised by a test or a CI script. Only when stdin is an unreadable
# terminal (or already closed) does it reach for /dev/tty.
#
# An earlier version preferred /dev/tty unconditionally to keep piped input from
# being eaten as menu answers. That is the wrong trade: it blocks forever when
# there is no controlling terminal (a pipe, a container, this sandbox), which
# looks exactly like a hang. Echoing the choice back on EOF keeps the transcript
# readable either way.
menu_read() {
  prompt="$1"
  # The prompt goes to stderr, never stdout: callers use
  # `choice=$(menu_read ...)`, and anything written to stdout inside `$(...)`
  # becomes part of the captured value. Printing it to stdout made every answer
  # arrive as "  > 9", so no menu arm ever matched.
  printf '%s' "$prompt" >&2
  if [ -t 0 ]; then
    IFS= read -r answer || answer=""
  elif [ -r /dev/tty ] && [ ! -p /dev/stdin ]; then
    IFS= read -r answer < /dev/tty || answer=""
  else
    IFS= read -r answer || answer=""
  fi
  printf '%s' "$answer"
}

show_menu() {
  say ""
  printf '%s┌──────────────────────────────────────────────┐%s\n' "$C_BLUE" "$C_RESET"
  printf '%s│%s  %sCFPress%s  %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_DIM" "$ROOT" "$C_RESET"
  printf '%s├──────────────────────────────────────────────┤%s\n' "$C_BLUE" "$C_RESET"
  printf '%s│%s  %s1%s) 启动本地服务   dev (port %s)\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET" "$DEV_PORT"
  printf '%s│%s  %s2%s) 本地数据库迁移  migrate --local\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s│%s  %s3%s) 部署主题        theme deploy\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s│%s  %s4%s) 跑全部测试      test (per suite)\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s│%s  %s5%s) 类型检查        tsc --noEmit\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s│%s  %s6%s) 租户/语言审计   audit\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s│%s  %s7%s) 部署            deploy\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s│%s  %s8%s) 部署+远程迁移   deploy:full\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s│%s  %s9%s) 诊断环境        doctor\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s└──────────────────────────────────────────────┘%s\n' "$C_BLUE" "$C_RESET"
  dim "  other:  t2 <name> 单套件 · mk <theme|plugin|table> <name> · cfg 生成部署配置 · v 版本 · h 帮助 · q 退出"
}

menu_loop() {
  # Reads from stdin when it is a pipe ('printf "9\nq\n" | cfpress.sh'), which
  # is how automated checks drive the menu. Only a real tty gets the /dev/tty
  # path. When the input runs out, the loop ends instead of spinning on an
  # empty choice forever — "no more input" is not "ask again".
  eof=""
  while :; do
    show_menu
    choice=$(menu_read "  > ")
    if [ -z "$choice" ] && ! [ -t 0 ]; then
      say ""
      dim "  (end of input — leaving the menu)"
      return 0
    fi
    case "$choice" in
      1) act_dev ;;
      2) act_migrate_local ;;
      3) theme=$(menu_read "  theme dir [content/themes/default]: "); act_theme_deploy "${theme:-content/themes/default}" ;;
      4) act_test ;;
      5) act_typecheck ;;
      6) act_audit ;;
      7) act_deploy "$(menu_read "  confirm deploy to production? [y/N] " | tr 'A-Z' 'a-z' | grep -q '^y' && echo '' || echo '--abort')" ;;
      8) act_deploy_full "$(menu_read "  confirm deploy + remote migrations? [y/N] " | tr 'A-Z' 'a-z' | grep -q '^y' && echo '' || echo '--abort')" ;;
      9) act_doctor ;;
      t2\ *) act_test "$(printf '%s' "$choice" | cut -d' ' -f2)" ;;
      mk\ *) set -- $(printf '%s' "$choice"); act_make "$2" "$3" ;;
      cfg|config) ensure_config ;;
      v) act_version ;;
      h|help|'') act_help ;;
      q|quit|exit) say "bye."; return 0 ;;
      *) warn "unknown choice: $choice" ;;
    esac
  done
}

# `--abort` is how the menu says "the user said no" without a second code path.
# Handled here so the action functions never need to know about the menu.
abort_guard() {
  for a in "$@"; do
    [ "$a" = "--abort" ] && { warn "aborted."; return 1; }
  done
  return 0
}

# --- dispatch ----------------------------------------------------------------
main() {
  if [ "$#" -eq 0 ]; then
    menu_loop
    return 0
  fi

  action="$1"; shift || true

  case "$action" in
    -h|--help|help)   act_help ;;
    -v|--version|version) act_version ;;
    dev)              act_dev ;;
    config|config:gen|config:generate) ensure_config ;;
    migrate:local|migrate-local|db:migrate:local) act_migrate_local ;;
    migrate:remote|migrate-remote|db:migrate) act_migrate_remote ;;
    theme|theme:deploy) act_theme_deploy "$@" ;;
    seed|seed:demo)   act_seed ;;
    hosts)            act_hosts "$@" ;;
    test|test:all)    act_test "${1:-}" ;;
    typecheck|types:check) act_typecheck ;;
    types)            act_types ;;
    audit)            act_audit ;;
    make|make:theme|make:plugin|make:table) act_make "$@" ;;
    deploy)
      abort_guard "$@" || return 0
      act_deploy "$@"
      ;;
    deploy:full|deploy-full)
      abort_guard "$@" || return 0
      act_deploy_full "$@"
      ;;
    doctor)           act_doctor ;;
    install)          act_install ;;
    *) die "unknown action \"$action\" — run: $0 help" ;;
  esac
}

main "$@"
