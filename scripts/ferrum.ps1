param(
  [Parameter(Position=0)] [string]$Command = "dashboard",
  [Parameter(ValueFromRemainingArguments=$true)] [string[]]$Rest
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
node (Join-Path $root "bin/ferrum.mjs") $Command @Rest
