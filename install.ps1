#!/usr/bin/env pwsh
#Requires -Version 5.1
<#
.SYNOPSIS
  Occ installer for Windows (PowerShell)

.DESCRIPTION
  Downloads and installs the Occ CLI for Windows. Handles x64/arm64, musl/baseline detection,
  and adds the install directory to the user's PATH.

.PARAMETER Version
  Specific version to install (e.g. 0.1.0 or v0.1.0). Defaults to latest.

.PARAMETER Binary
  Install from a local binary path instead of downloading.

.PARAMETER NoModifyPath
  Don't modify the user's PATH.

.EXAMPLE
  irm https://raw.githubusercontent.com/qubexs/occ/main/install.ps1 | iex
  .\install.ps1 -Version 0.1.0
  .\install.ps1 -Binary C:\path\to\occ.exe
#>
[CmdletBinding()]
param(
  [string]$Version = $env:VERSION,
  [string]$Binary = "",
  [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"
$App = "occ"
$Repo = if ($env:OCC_REPO) { $env:OCC_REPO } else { "qubexs/occ" }
$InstallDir = Join-Path $HOME ".occ\bin"

function Write-Info($msg) { Write-Host $msg }
function Write-Warn($msg) { Write-Host "WARN: $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --binary path install
if ($Binary) {
  if (-not (Test-Path $Binary)) { Write-Err "Binary not found at $Binary" }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $dest = Join-Path $InstallDir "occ.exe"
  Copy-Item -Force $Binary $dest
  Write-Info "Installed Occ from $Binary -> $dest"
} else {
  # Detect arch
  $arch = $env:PROCESSOR_ARCHITECTURE
  # On ARM64 Windows, PROCESSOR_ARCHITECTURE may still report AMD64 under emulation, check via env
  if ($arch -eq "AMD64" -or $arch -eq "x64") { $arch = "x64" }
  elseif ($arch -eq "ARM64") { $arch = "arm64" }
  else {
    # fallback via WMI
    try { $arch = (Get-CimInstance Win32_Processor).Architecture; if ($arch -eq 12) { $arch = "arm64" } else { $arch = "x64" } } catch { $arch = "x64" }
  }
  $os = "windows"

  # AVX2 / baseline detection for x64
  $needsBaseline = $false
  if ($arch -eq "x64") {
    try {
      Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int f);' -Name K32 -Namespace Win32 -PassThru | Out-Null
      $hasAvx2 = [Win32.K32]::IsProcessorFeaturePresent(40)
      if (-not $hasAvx2) { $needsBaseline = $true }
    } catch { $needsBaseline = $false }
  }

  $target = "$os-$arch"
  if ($needsBaseline) { $target = "$target-baseline" }

  $filename = "$App-$target.zip"

  # Resolve version
  $specificVersion = $null
  $url = $null
  if (-not $Version) {
    Write-Info "Fetching latest version..."
    try {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "occ-installer" }
      $tag = $release.tag_name
      $specificVersion = $tag.TrimStart("v")
      $url = "https://github.com/$Repo/releases/latest/download/$filename"
    } catch { Write-Err "Failed to fetch latest version: $($_.Exception.Message)" }
  } else {
    $v = $Version.TrimStart("v")
    $specificVersion = $v
    $url = "https://github.com/$Repo/releases/download/v$v/$filename"
    # Verify exists
    try {
      $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/tag/v$v" -UseBasicParsing -Method Head
    } catch {
      if ($_.Exception.Response.StatusCode -eq 404) { Write-Err "Release v$v not found. See https://github.com/$Repo/releases" }
    }
  }

  Write-Info "Installing Occ $specificVersion ($target) from $url"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $tmpDir = Join-Path $env:TEMP "occ_install_$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $zipPath = Join-Path $tmpDir $filename
  try {
    # Download with progress
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "occ-installer")
    $wc.DownloadFile($url, $zipPath)
  } catch { Write-Err "Download failed: $($_.Exception.Message)" }

  try {
    Expand-Archive -Force -Path $zipPath -DestinationPath $tmpDir
  } catch { Write-Err "Failed to extract $zipPath : $($_.Exception.Message)" }

  $bin = Get-ChildItem -Recurse -Filter "occ.exe" $tmpDir | Select-Object -First 1
  if (-not $bin) { $bin = Get-ChildItem -Recurse -Filter "occ" $tmpDir | Select-Object -First 1 }
  if (-not $bin) { Write-Err "occ binary not found in archive" }
  Copy-Item -Force $bin.FullName (Join-Path $InstallDir "occ.exe")
  Remove-Item -Recurse -Force $tmpDir
  Write-Info "Installed to $InstallDir\occ.exe"
}

# Add to PATH
if (-not $NoModifyPath) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -split ";" -notcontains $InstallDir) {
    $newPath = "$userPath;$InstallDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = "$env:Path;$InstallDir"
    Write-Info "Added $InstallDir to user PATH. Restart your terminal."
  } else {
    Write-Info "$InstallDir already in PATH"
  }
}

Write-Host ""
Write-Host "  Occ CLI coding agent" -ForegroundColor White
Write-Host ""
Write-Host "Quick start:"
Write-Host "  occ --help         # show help"
Write-Host "  occ mini           # interactive chat"
Write-Host "  occ run ""...""     # one-shot prompt"
Write-Host ""
Write-Host "Docs: https://github.com/qubexs/occ#readme"
Write-Host ""
