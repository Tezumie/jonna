# Shell integration for PowerShell 7 and Windows PowerShell (dot-sourced at start). Marks as in
# bash.sh (OSC 633). Also turns off PSReadLine's own bell: the IDE's terminal.bell setting decides.
if (-not $global:__IdeIntegration) {
  $global:__IdeIntegration = $true
  # The secret the IDE checks on command lines (E): kept here, out of every program's sight.
  $global:__IdeNonce = $env:IDE_SHELL_NONCE
  Remove-Item Env:IDE_SHELL_NONCE -ErrorAction SilentlyContinue
  $global:__IdeLastHistoryId = -1
  $global:__IdeRan = $false
  # The first prompt's history holds only the line that loaded this script (-Command): not a
  # command of the user's, so it isn't reported (a command sent at once took its result).
  $global:__IdeFirstPrompt = $true
  if (Get-Module -ListAvailable -Name PSReadLine) {
    try { Set-PSReadLineOption -BellStyle None } catch {}
  }
  function global:__IdeEscape([string]$s) {
    return $s.Replace('\', '\\').Replace(';', '\x3b').Replace("`n", '\x0a').Replace("`r", '\x0d')
  }
  $global:__IdeOriginalPrompt = $function:prompt
  function global:prompt {
    $ok = $?
    $savedExit = $global:LASTEXITCODE
    $code = if ($ok) { 0 } else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }
    $e = [char]27; $b = [char]7
    $out = ''
    $last = Get-History -Count 1
    if ($global:__IdeFirstPrompt) {
      $global:__IdeFirstPrompt = $false
      if ($last) { $global:__IdeLastHistoryId = $last.Id }
    } elseif ($global:__IdeRan) {
      # The Enter handler already sent the command line (E) and "executed" (C).
      $global:__IdeRan = $false
      if ($last) { $global:__IdeLastHistoryId = $last.Id }
      $out += "$e]633;D;$code$b"
    } elseif ($last -and $last.Id -ne $global:__IdeLastHistoryId) {
      # Without PSReadLine's Enter handler: the command line from history, at the next prompt.
      $global:__IdeLastHistoryId = $last.Id
      $out += "$e]633;E;$(__IdeEscape $last.CommandLine);$($global:__IdeNonce)$b$e]633;D;$code$b"
    }
    $out += "$e]633;P;Cwd=$(__IdeEscape $PWD.ProviderPath)$b$e]633;A$b"
    # The user's prompt (oh-my-posh, starship…) still sees the command's $? and exit code: the
    # lines above reset $?, so it's failed again here, as VS Code does.
    $global:LASTEXITCODE = $savedExit
    if (-not $ok) { Write-Error 'failure' -ErrorAction Ignore }
    $out += & $global:__IdeOriginalPrompt
    $out += "$e]633;B$b"
    return $out
  }
  # Windows PowerShell 5.1 has no && / || (PowerShell 7 does): rewrite them before running, left
  # to right like a shell, with a status variable (pty/chain.rs has the same, tested):
  # "a && b || c" -> "a; $__ideOk = $?; if ($__ideOk) { b; $__ideOk = $? }; if (-not $__ideOk) { c; ... }".
  function global:__IdeChain([string]$line) {
    $parts = New-Object System.Collections.Generic.List[string]
    $ops = New-Object System.Collections.Generic.List[string]
    $cur = New-Object System.Text.StringBuilder
    $quote = [char]0
    $i = 0
    while ($i -lt $line.Length) {
      $c = $line[$i]
      if ($quote -ne [char]0) {
        [void]$cur.Append($c)
        if ($c -eq [char]'`' -and $quote -eq [char]'"' -and $i + 1 -lt $line.Length) {
          [void]$cur.Append($line[$i + 1]); $i += 2; continue
        }
        if ($c -eq $quote) { $quote = [char]0 }
        $i++; continue
      }
      if ($c -eq [char]"'" -or $c -eq [char]'"') { $quote = $c; [void]$cur.Append($c); $i++; continue }
      if ($c -eq [char]'`' -and $i + 1 -lt $line.Length) {
        [void]$cur.Append($c); [void]$cur.Append($line[$i + 1]); $i += 2; continue
      }
      if (($c -eq [char]'&' -or $c -eq [char]'|') -and $i + 1 -lt $line.Length -and $line[$i + 1] -eq $c) {
        $parts.Add($cur.ToString().Trim()); [void]$cur.Clear()
        if ($c -eq [char]'&') { $ops.Add('$__ideOk') } else { $ops.Add('-not $__ideOk') }
        $i += 2; continue
      }
      [void]$cur.Append($c); $i++
    }
    $parts.Add($cur.ToString().Trim())
    if ($ops.Count -eq 0) { return $null }
    foreach ($p in $parts) { if (-not $p) { return $null } }
    $out = $parts[0] + '; $__ideOk = $?'
    for ($k = 0; $k -lt $ops.Count; $k++) {
      $out += '; if (' + $ops[$k] + ') { ' + $parts[$k + 1] + '; $__ideOk = $? }'
    }
    return $out
  }
  if (Get-Module -Name PSReadLine) {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
      $line = $null; $cursor = $null
      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
      # Unfinished input (`if ($x) {`): Enter only starts a continuation line, nothing runs yet.
      $tokens = $null; $errors = $null
      [void][System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$tokens, [ref]$errors)
      if ($errors | Where-Object { $_.IncompleteInput }) {
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        return
      }
      if ($PSVersionTable.PSVersion.Major -lt 7) {
        $chained = __IdeChain $line
        if ($chained) { [Microsoft.PowerShell.PSConsoleReadLine]::Replace(0, $line.Length, $chained) }
      }
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
      # The command line (E) now, before "executed" (C), so the IDE knows which command runs; an
      # empty line runs nothing, so no C (it left the IDE thinking a command was running).
      if ($line.Trim()) {
        $global:__IdeRan = $true
        $e = [char]27; $b = [char]7
        [Console]::Write("$e]633;E;$(__IdeEscape $line);$($global:__IdeNonce)$b$e]633;C$b")
      }
    }
  }
}
