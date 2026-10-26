# ascian installer for Windows. Fetches one file into ~\.ascian and adds a launcher to PATH.
$ErrorActionPreference = "Stop"
$origin = if ($env:ASCIAN_ORIGIN) { $env:ASCIAN_ORIGIN } else { "https://ascian.fun" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Node 18 or newer is needed: https://nodejs.org"; exit 1 }
$dir = Join-Path $HOME ".ascian"; $bin = Join-Path $dir "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Invoke-WebRequest -UseBasicParsing "$origin/cli/ascian.mjs" -OutFile (Join-Path $dir "ascian.mjs")
Set-Content -Path (Join-Path $bin "ascian.cmd") -Value "@node `"%USERPROFILE%\.ascian\ascian.mjs`" %*" -Encoding ASCII
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$bin*") { [Environment]::SetEnvironmentVariable("Path", "$userPath;$bin", "User"); Write-Host "Added $bin to PATH. Open a new terminal." }
Write-Host "Installed. Next: ascian login"
