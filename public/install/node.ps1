# Decentralised.si: turn this Windows computer into a network node, and unlock free network chat.
#
#   irm https://decentralised.si/install/node.ps1 | iex
#   & ([scriptblock]::Create((irm https://decentralised.si/install/node.ps1))) -Uninstall
#
# 1. asks for your API key (create one at https://decentralised.si/app#/console/keys)
# 2. picks an open model that fits this computer's memory and installs it with Ollama
# 3. installs Node.js (a private copy, if yours is older than 20) and cloudflared (secure tunnel)
# 4. downloads dsi-node, checks its SHA-256, and starts it now and at every sign-in
# Everything lives in %LOCALAPPDATA%\dsi. The node pauses while the laptop runs on battery.
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Base = if ($env:DSI_BASE_URL) { $env:DSI_BASE_URL } else { "https://decentralised.si" }
$Home_ = Join-Path $env:LOCALAPPDATA "dsi"
$Bin = Join-Path $Home_ "bin"
$Port = if ($env:PORT) { $env:PORT } else { "8787" }
$Task = "Decentralised.si node"

function Step($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Die($m) { Write-Host "Error: $m" -ForegroundColor Red; exit 1 }
function Sha256($p) { (Get-FileHash -Algorithm SHA256 $p).Hash.ToLower() }
function Stop-Node {
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Home_*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Step "Removing the Decentralised.si node"
  Stop-Node
  $envFile = Join-Path $Home_ "node.env"; $state = Join-Path $Home_ "state.json"
  if ((Test-Path $envFile) -and (Test-Path $state)) {
    $cfg = @{}; Get-Content $envFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $cfg[$matches[1]] = $matches[2] } }
    $id = (Get-Content $state -Raw | ConvertFrom-Json).nodeId
    try { Invoke-RestMethod -Method Delete "$($cfg.DSI_ROUTER)/api/nodes/$id" -Headers @{ authorization = "Bearer $($cfg.DSI_API_KEY)" } | Out-Null; Write-Host "Node $id removed from the network." } catch {}
  }
  Remove-Item -Recurse -Force $Home_ -ErrorAction SilentlyContinue
  Write-Host "Done. Ollama and its models were left in place (remove them with 'ollama rm <model>')."
  exit 0
}

Write-Host "Decentralised.si node installer"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

# ---------------------------------------------------------------- 1. API key
$Key = $env:DSI_API_KEY
$envFile = Join-Path $Home_ "node.env"
if (-not $Key -and (Test-Path $envFile)) { $Key = ((Get-Content $envFile) -match '^DSI_API_KEY=' -replace '^DSI_API_KEY=', '') | Select-Object -First 1 }
if (-not $Key) {
  Write-Host ""
  Write-Host "Sign in at $Base/app, open Console -> API keys, create a key and paste it here."
  $Key = Read-Host "API key"
}
if ($Key -notlike "ds_*") { Die "that does not look like a Decentralised.si key (they start with ds_)" }

# ---------------------------------------------------------------- 2. model for this computer
$MemGB = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$Model = if ($env:DSI_MODEL) { $env:DSI_MODEL } elseif ($MemGB -lt 6) { "qwen2.5:1.5b" } elseif ($MemGB -lt 12) { "llama3.2:3b" } elseif ($MemGB -lt 24) { "qwen2.5:7b" } else { "qwen2.5:14b" }
Step "1/4  Model: $Model (this computer has $MemGB GB of memory)"

# ---------------------------------------------------------------- 3. Ollama + model
$Ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $Ollama) { $c = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"; if (Test-Path $c) { $Ollama = $c } }
if (-not $Ollama) {
  Write-Host "Installing Ollama (runs the model on this computer)..."
  $setup = Join-Path $Home_ "OllamaSetup.exe"
  Invoke-WebRequest "https://ollama.com/download/OllamaSetup.exe" -OutFile $setup
  Start-Process $setup -ArgumentList "/VERYSILENT", "/NORESTART" -Wait
  Remove-Item $setup -Force
  $Ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
}
if (-not (Test-Path $Ollama)) { Die "Ollama could not be installed; install it from https://ollama.com and run this again" }
function Test-Ollama { try { Invoke-RestMethod http://127.0.0.1:11434/api/tags -TimeoutSec 2 | Out-Null; $true } catch { $false } }
if (-not (Test-Ollama)) {
  Start-Process $Ollama -ArgumentList "serve" -WindowStyle Hidden
  $i = 0; while (-not (Test-Ollama)) { $i++; if ($i -gt 30) { Die "Ollama did not start" }; Start-Sleep 1 }
}
Write-Host "Downloading $Model (the first time takes a few minutes)..."
& $Ollama pull $Model
if ($LASTEXITCODE -ne 0) { Die "could not download $Model" }

# ---------------------------------------------------------------- 4. Node.js, cloudflared, dsi-node
Step "2/4  Node runtime and secure tunnel"
$NodeExe = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and [int](& node -p "process.versions.node.split('.')[0]") -ge 20) { $NodeExe = $sys.Source }
if (-not $NodeExe) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[0-9.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Die "no Node.js build for win-$arch" }
  $sha, $file = $line -split '\s+'
  $zip = Join-Path $Home_ "node.zip"
  Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$file" -OutFile $zip
  if ((Sha256 $zip) -ne $sha) { Die "Node.js download failed its checksum" }
  $dest = Join-Path $Home_ "node"; Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $Home_ -Force; Remove-Item $zip
  Rename-Item (Join-Path $Home_ ($file -replace '\.zip$', '')) $dest
  $NodeExe = Join-Path $dest "node.exe"
}

$Cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $Cf) {
  $Cf = Join-Path $Bin "cloudflared.exe"
  # cloudflared ships no Windows arm64 build; the amd64 one runs under emulation.
  Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $Cf
}

$Mjs = Join-Path $Home_ "dsi-node.mjs"
Invoke-WebRequest "$Base/dl/dsi-node.mjs" -OutFile $Mjs -UseBasicParsing
$expected = ((Invoke-WebRequest "$Base/dl/SHA256SUMS" -UseBasicParsing).Content -split "`n" | Where-Object { $_ -match '\sdsi-node\.mjs$' }) -split '\s+' | Select-Object -First 1
if ((Sha256 $Mjs) -ne $expected) { Die "dsi-node.mjs failed its checksum" }

# ---------------------------------------------------------------- settings + launcher
$router = if ($env:DSI_ROUTER) { $env:DSI_ROUTER } else { "https://api.decentralised.si" }
$pause = if ($env:DSI_PAUSE_ON_BATTERY) { $env:DSI_PAUSE_ON_BATTERY } else { "1" }
@"
DSI_API_KEY=$Key
DSI_ROUTER=$router
DSI_MODELS=$Model
NODE_NAME=laptop-$($env:COMPUTERNAME.ToLower())
PORT=$Port
LLM_BASE_URL=http://127.0.0.1:11434/v1
CLOUDFLARED_METRICS=http://127.0.0.1:20241
DSI_NODE_STATE=$(Join-Path $Home_ "state.json")
MAX_CONCURRENCY=1
DSI_PAUSE_ON_BATTERY=$pause
"@ | Set-Content -Encoding ascii $envFile
# Only this user may read the key.
icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

$Launcher = Join-Path $Bin "dsi-node-up.ps1"
@"
# Starts Ollama (if needed), the tunnel and the node. Log: $Home_\node.log
Get-Content '$envFile' | ForEach-Object { if (`$_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:`$(`$matches[1])" -Value `$matches[2] } }
try { Invoke-RestMethod http://127.0.0.1:11434/api/tags -TimeoutSec 2 | Out-Null } catch { Start-Process '$Ollama' -ArgumentList 'serve' -WindowStyle Hidden }
`$tunnel = Start-Process '$Cf' -ArgumentList 'tunnel','--no-autoupdate','--protocol','http2','--url',"http://127.0.0.1:`$env:PORT",'--metrics','127.0.0.1:20241' -WindowStyle Hidden -PassThru -RedirectStandardError '$Home_\tunnel.log'
`$node = Start-Process '$NodeExe' -ArgumentList '"$Mjs"','up' -WindowStyle Hidden -PassThru -RedirectStandardOutput '$Home_\node.log' -RedirectStandardError '$Home_\node.err.log'
# The node and its tunnel live and die together; the scheduled task restarts the pair.
try { while (-not `$tunnel.HasExited -and -not `$node.HasExited) { Start-Sleep 5 } } finally {
  Stop-Process -Id `$node.Id -Force -ErrorAction SilentlyContinue; Stop-Process -Id `$tunnel.Id -Force -ErrorAction SilentlyContinue }
exit 1
"@ | Set-Content -Encoding utf8 $Launcher

# ---------------------------------------------------------------- 5. start (and start at sign-in)
Step "3/4  Starting the node"
Stop-Node
$log = Join-Path $Home_ "node.log"; Set-Content $log ""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Task

Step "4/4  Joining the network"
$i = 0
while (-not (Select-String -Path $log -Pattern "live at" -Quiet -ErrorAction SilentlyContinue)) {
  $i++
  if ($i -gt 90) { Write-Host "Still starting; follow progress with: Get-Content -Wait $log"; exit 0 }
  Start-Sleep 2
}
(Select-String -Path $log -Pattern "live at" | Select-Object -Last 1).Line
Write-Host ""
Write-Host "Your computer is now a Decentralised.si node, serving $Model."
Write-Host "  - Free chat: after its first checks (usually under an hour) you get 20,000 free tokens a day,"
Write-Host "    plus every token your node serves. Open $Base/app and choose"
Write-Host "    'Free - community nodes'."
Write-Host "  - It pauses on battery, starts at sign-in, and only answers requests signed by the network."
Write-Host "  - Log: $log"
