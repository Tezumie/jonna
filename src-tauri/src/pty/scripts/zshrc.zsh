# Shell integration for zsh: loaded as $ZDOTDIR/.zshrc; restores the user's ZDOTDIR and sources
# their .zshrc first. Marks as in bash.sh (OSC 633 A/B/C/D/E/P).
# The secret the IDE checks on command lines (E): kept here, out of every program's sight.
__ide_nonce="$IDE_SHELL_NONCE"
unset IDE_SHELL_NONCE
ZDOTDIR="${IDE_USER_ZDOTDIR:-$HOME}"
[ -r "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
__ide_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  print -rn -- "$s"
}
__ide_in_command=0
__ide_eol_mark_set=0
__ide_preexec() {
  __ide_in_command=1
  printf '\e]633;E;%s;%s\a\e]633;C\a' "$(__ide_escape "$1")" "$__ide_nonce"
  # PROMPT_SP prints PROMPT_EOL_MARK (the inverse % or #) before precmd runs: a D mark printed in
  # precmd would leave it in the command's output. Prefixing the mark with D ends the command
  # first (%? is its exit code); precmd puts the user's mark back.
  if [[ -o prompt_sp && -o prompt_cr ]]; then
    if (( ${+PROMPT_EOL_MARK} )); then __ide_user_eol_mark="$PROMPT_EOL_MARK"; __ide_eol_mark_set=1
    else __ide_user_eol_mark='%B%S%#%s%b'; __ide_eol_mark_set=0; fi
    PROMPT_EOL_MARK=$'%{\e]633;D;%?\a%}'"$__ide_user_eol_mark"
    __ide_in_command=2
  fi
}
__ide_precmd() {
  local code=$?
  [ "$__ide_in_command" = 1 ] && print -n "\e]633;D;$code\a"
  if [ "$__ide_in_command" = 2 ]; then
    if [ "$__ide_eol_mark_set" = 1 ]; then PROMPT_EOL_MARK="$__ide_user_eol_mark"
    else unset PROMPT_EOL_MARK; fi
  fi
  __ide_in_command=0
  printf '\e]633;P;Cwd=%s\a' "$(__ide_escape "$PWD")"
  # Themes that rebuild the prompt at every precmd (powerlevel10k, pure…) drop the marks.
  [[ "$PS1" == *'633;A'* ]] || PS1=$'%{\e]633;A\a%}'"$PS1"$'%{\e]633;B\a%}'
  return $code
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __ide_preexec
add-zsh-hook precmd __ide_precmd
PS1=$'%{\e]633;A\a%}'"$PS1"$'%{\e]633;B\a%}'
