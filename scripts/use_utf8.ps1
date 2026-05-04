# Shared UTF-8 guard for Windows PowerShell 5.1.
#
# Why this exists:
# Windows PowerShell 5.1 keeps $OutputEncoding as US-ASCII by default, even when
# the console itself is UTF-8.  Non-ASCII text then becomes '?' when piped to
# native programs such as node.exe, python.exe, lark-cli.exe, psql, etc.
#
# Dot-source this file near the top of any project .ps1 that calls native
# programs or writes Chinese text:
#   . "$PSScriptRoot\use_utf8.ps1"

try {
  $script:SheinUtf8NoBom = [System.Text.UTF8Encoding]::new($false)
} catch {
  $script:SheinUtf8NoBom = New-Object System.Text.UTF8Encoding($false)
}

[Console]::InputEncoding = $script:SheinUtf8NoBom
[Console]::OutputEncoding = $script:SheinUtf8NoBom
$global:OutputEncoding = $script:SheinUtf8NoBom

$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:NODE_DISABLE_COLORS = $env:NODE_DISABLE_COLORS

$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Export-Csv:Encoding'] = 'utf8'
