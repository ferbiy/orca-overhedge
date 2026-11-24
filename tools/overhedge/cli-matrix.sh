#!/usr/bin/env bash
# Runs INSIDE the smoke container as the throwaway user. Prints each command, its output and exit code.
r(){ echo "### \$ $*"; timeout 90 "$@" 2>&1 | grep -vE 'authToken|"token"' | head -${N:-25}; echo "exit=${PIPESTATUS[0]}"; }
O=orca-ide
mkdir -p ~/proj && cd ~/proj && { [ -d .git ] || { git init -q -b main . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }; }
N=12 r $O repo add --help
r $O repo add --path ~/proj
r $O repo add ~/proj
r $O repo list --json
r $O --version
N=60 r $O status --json
r $O account list
N=20 r $O account select --help
N=40 r $O account migrate --help
r $O account migrate --to nobody@example.com --chat no-such-chat --dry-run
r $O account migrate --to nobody@example.com --chat terminal:no-such-pane --dry-run
r $O account migrate --to nobody@example.com --all-on other@example.com --dry-run
r $O account migrate --to nobody@example.com --with-workers no-such-coord --dry-run
r $O account migrate --unpin --chat no-such-chat --dry-run
r $O account migrate --unpin --all-on nobody@example.com --dry-run
r $O account migrate --to nobody@example.com --chat no-such-chat --restart --dry-run
r $O account migrate --to nobody@example.com --chat no-such-chat --restart
r $O account migrate --to nobody@example.com --chat no-such-chat --restart --yes
r $O account migrate --to nobody@example.com --chat no-such-chat --restart --timeout 5 --yes
echo "--- invalid combinations"
r $O account migrate --dry-run
r $O account migrate --to nobody@example.com --dry-run
r $O account migrate --chat no-such-chat --dry-run
r $O account migrate --to nobody@example.com --unpin --chat x --dry-run
r $O account migrate --unpin --chat x --yes
r $O account migrate --to nobody@example.com --chat x --timeout 5
r $O account migrate --to nobody@example.com --chat x --bogus
echo "--- launch --account (state before)"
WT0=$($O worktree list --json 2>/dev/null | md5sum); RUN0=$($O orchestration run-list --json 2>/dev/null | md5sum); TL0=$($O terminal list --json 2>/dev/null | md5sum)
r $O agent launch --agent claude --worktree path:$HOME/proj --account nobody@example.com --prompt hi --json
r $O agent launch --agent codex --worktree path:$HOME/proj --account nobody@example.com --json
r $O worktree create --name ovh-smoke-wt --repo path:$HOME/proj --agent claude --account nobody@example.com --json
r $O worktree create --name ovh-smoke-wt2 --repo path:$HOME/proj --agent codex --account nobody@example.com --json
r $O orchestration worker-start --spec "smoke" --agent claude --account nobody@example.com --worktree path:$HOME/proj --json
r $O orchestration worker-start --spec "smoke" --terminal no-such --account nobody@example.com --json
echo "--- state after (same = nothing created)"
[ "$WT0" = "$($O worktree list --json 2>/dev/null | md5sum)" ] && echo "worktree list unchanged" || { echo "worktree list CHANGED"; $O worktree list 2>&1 | head; }
[ "$RUN0" = "$($O orchestration run-list --json 2>/dev/null | md5sum)" ] && echo "run list unchanged" || { echo "run list CHANGED"; $O orchestration run-list 2>&1 | head; }
[ "$TL0" = "$($O terminal list --json 2>/dev/null | md5sum)" ] && echo "terminal list unchanged" || echo "terminal list CHANGED"
N=8 r $O orchestration task-list --json
ls ~/proj/.. ; git -C ~/proj worktree list
