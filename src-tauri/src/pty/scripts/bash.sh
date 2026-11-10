# Shell integration for bash (loaded with --init-file). Emits OSC 633 marks: A prompt start,
# B prompt end, C command output start (PS0, bash 4.4+), D;exit command done, E;command line,
# P;Cwd=dir. The user's own startup files run first, so their prompt and settings stay.
if [ -z "$__IDE_INTEGRATION_LOADED" ]; then
  __IDE_INTEGRATION_LOADED=1
  # The secret the IDE checks on command lines (E): kept here, out of every program's sight.
  __ide_nonce="$IDE_SHELL_NONCE"
  unset IDE_SHELL_NONCE
  if [ "$IDE_SHELL_LOGIN" = 1 ]; then
    # Login shell semantics (macOS terminals): /etc/profile, then the first user profile.
    [ -r /etc/profile ] && . /etc/profile
    for __ide_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      [ -r "$__ide_f" ] && { . "$__ide_f"; break; }
    done
  else
    [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
    [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
  fi
  unset IDE_SHELL_LOGIN

  __ide_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//;/\\x3b}"
    s="${s//$'\n'/\\x0a}"
    printf '%s' "$s"
  }
  __ide_last_hist=""
  __ide_precmd() {
    local code=$? line num
    line="$(HISTTIMEFORMAT= history 1)"
    num="${line%%[^ 0-9]*}"
    if [ -n "$line" ] && [ "$num" != "$__ide_last_hist" ] && [ -n "$__ide_last_hist$__ide_started" ]; then
      printf '\033]633;E;%s;%s\007' "$(__ide_escape "$(printf '%s' "$line" | sed 's/^ *[0-9]* *//')")" "$__ide_nonce"
    fi
    [ -n "$__ide_started" ] && printf '\033]633;D;%s\007' "$code"
    __ide_last_hist="$num"
    __ide_started=1
    printf '\033]633;P;Cwd=%s\007' "$(__ide_escape "$PWD")"
    # The user's PROMPT_COMMAND (and a prompt theme) still sees the command's exit status.
    return "$code"
  }
  # Prompt themes that rebuild PS1 at every prompt (powerline-go, liquidprompt…) drop the
  # marks: put them back after the user's PROMPT_COMMAND ran, keeping $? for PS1.
  __ide_wrap_ps1() {
    local code=$?
    case "$PS1" in
      *'633;A'*) ;;
      *) PS1="\[\033]633;A\007\]$PS1\[\033]633;B\007\]" ;;
    esac
    return "$code"
  }
  # Newlines, not "; ": a user's PROMPT_COMMAND often ends in ";" ("history -a;").
  PROMPT_COMMAND=$'__ide_precmd\n'"${PROMPT_COMMAND}"$'\n__ide_wrap_ps1'
  PS0=$'\e]633;C\a'"${PS0}"
  PS1="\[\033]633;A\007\]$PS1\[\033]633;B\007\]"
fi
