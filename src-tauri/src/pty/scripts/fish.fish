# Shell integration for fish (loaded with --init-command). Marks as in bash.sh (OSC 633).
# The secret the IDE checks on command lines (E): kept here, out of every program's sight.
set -g __ide_nonce $IDE_SHELL_NONCE
set -e IDE_SHELL_NONCE
function __ide_escape
    string replace -a '\\' '\\\\' -- $argv | string replace -a ';' '\\x3b'
end
function __ide_preexec --on-event fish_preexec
    printf '\e]633;E;%s;%s\a\e]633;C\a' (__ide_escape "$argv") "$__ide_nonce"
    set -g __ide_in_command 1
end
function __ide_postexec --on-event fish_postexec
    printf '\e]633;D;%s\a' $status
    set -g __ide_in_command 0
end
function __ide_cwd --on-event fish_prompt
    printf '\e]633;P;Cwd=%s\a' (__ide_escape "$PWD")
end
functions -c fish_prompt __ide_user_prompt
function fish_prompt
    printf '\e]633;A\a'
    __ide_user_prompt
    printf '\e]633;B\a'
end
