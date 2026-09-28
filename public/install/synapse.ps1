# Installs Synapse, the Decentralised.si local router, on Windows.
#   irm https://decentralised.si/install/synapse.ps1 | iex
# Options (environment variables): SYNAPSE_VERSION (default latest), SYNAPSE_INSTALL_DIR
# (default %LOCALAPPDATA%\synapse), SYNAPSE_NO_INIT=1 to skip creating %USERPROFILE%\.synapse config files.
# Source: https://github.com/Decentralised-si/Smart-LLM-Router/tree/main/synapse
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'Decentralised-si/Smart-LLM-Router'
$version = if ($env:SYNAPSE_VERSION) { $env:SYNAPSE_VERSION } elseif ($env:OIFD_VERSION) { $env:OIFD_VERSION } else { 'latest' }
$dir = if ($env:SYNAPSE_INSTALL_DIR) { $env:SYNAPSE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'synapse' }

$target = 'x86_64-pc-windows-msvc'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Host 'Windows on ARM: installing the x64 build, which runs under emulation.'
}
$asset = "synapse-$target.zip"
$base = if ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("synapse-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset ($version) ..."
  Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')
  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { ($_ -split '\s+')[1] -eq $asset } | Select-Object -First 1
  if (-not $line) { throw "$asset is not listed in SHA256SUMS" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if ($expected -ne $actual) { throw "checksum mismatch for $asset (expected $expected, got $actual)" }
  Write-Host 'Checksum verified.'

  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item (Join-Path $tmp "synapse-$target\synapse.exe") (Join-Path $dir 'synapse.exe') -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$exe = Join-Path $dir 'synapse.exe'
Write-Host "Installed $(& $exe --version) to $exe"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir"), 'User')
  $env:Path += ";$dir"
  Write-Host "Added $dir to your user PATH (open a new terminal to pick it up)."
}

if ($env:SYNAPSE_NO_INIT -ne '1') { & $exe init }
Write-Host ''
Write-Host "Chat and watch routing live:  run 'synapse', then open http://127.0.0.1:7766/"
Write-Host "Guide: https://decentralised.si/download#first-run"
