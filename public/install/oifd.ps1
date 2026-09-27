# Installs oifd, the Decentralised.si local router, on Windows.
#   irm https://decentralise.si/install/oifd.ps1 | iex
# Options (environment variables): OIFD_VERSION (default latest), OIFD_INSTALL_DIR
# (default %LOCALAPPDATA%\oifd), OIFD_NO_INIT=1 to skip creating %USERPROFILE%\.oif config files.
# Source: https://github.com/Decentralised-si/Smart-LLM-Router/tree/main/oif-router
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'Decentralised-si/Smart-LLM-Router'
$version = if ($env:OIFD_VERSION) { $env:OIFD_VERSION } else { 'latest' }
$dir = if ($env:OIFD_INSTALL_DIR) { $env:OIFD_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'oifd' }

$target = 'x86_64-pc-windows-msvc'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Host 'Windows on ARM: installing the x64 build, which runs under emulation.'
}
$asset = "oifd-$target.zip"
$base = if ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("oifd-" + [Guid]::NewGuid())
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
  Copy-Item (Join-Path $tmp "oifd-$target\oifd.exe") (Join-Path $dir 'oifd.exe') -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$exe = Join-Path $dir 'oifd.exe'
Write-Host "Installed $(& $exe --version) to $exe"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir"), 'User')
  $env:Path += ";$dir"
  Write-Host "Added $dir to your user PATH (open a new terminal to pick it up)."
}

if ($env:OIFD_NO_INIT -ne '1') { & $exe init }
Write-Host ''
Write-Host "Next: run 'oifd', then open https://decentralise.si/download#first-run"
