# Load-tests every module one after another and builds one results table.
#
#   powershell -ExecutionPolicy Bypass -File loadtest/run-modules.ps1                      # load test, every module
#   powershell -ExecutionPolicy Bypass -File loadtest/run-modules.ps1 -TestType smoke      # quick check of every module first
#   powershell -ExecutionPolicy Bypass -File loadtest/run-modules.ps1 -Modules loans,kadiwa
#
# Needs the load-test backend running in another terminal (node loadtest/local.mjs server).
# Results go to loadtest/results/<test type>-<date>-<time>/: one HTML report and one
# JSON file per module, plus summary.md and summary.csv with every module together.

param(
  [ValidateSet('smoke', 'load', 'stress', 'spike')]
  [string]$TestType = 'load',
  [string[]]$Modules = @(),
  [int]$MemberCount = 300,
  [int]$Vus = 30
)

$all = @('auth', 'dashboard', 'members', 'savings', 'loans', 'machinery', 'kadiwa', 'vendor', 'attendance', 'analytics', 'ocr', 'users', 'communication', 'about', 'member-portal')
# "-Modules loans,kadiwa" arrives as one string when run with -File.
$Modules = @($Modules | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Modules.Count -eq 0) { $Modules = $all }
$unknown = $Modules | Where-Object { $all -notcontains $_ }
if ($unknown) { Write-Host "Unknown module(s): $($unknown -join ', '). Choose from: $($all -join ', ')"; exit 1 }

$backend = Split-Path $PSScriptRoot -Parent
Set-Location $backend
$k6 = (Get-Command k6 -ErrorAction SilentlyContinue).Source
if (-not $k6) { $k6 = 'C:\Program Files\k6\k6.exe' }
if (-not (Test-Path $k6)) { Write-Host 'k6 not found. Install it with: winget install k6 --source winget'; exit 1 }

$out = "loadtest/results/$TestType-$(Get-Date -Format 'yyyyMMdd-HHmm')"
New-Item -ItemType Directory -Force $out | Out-Null
$minutes = @{ smoke = 0.6; load = 3.2; stress = 5.6; spike = 2.4 }[$TestType] * $Modules.Count
Write-Host "Testing $($Modules.Count) module(s), $TestType, about $([math]::Ceiling($minutes)) minutes. Results: $out"

$failed = @()
$i = 0
foreach ($m in $Modules) {
  $i++
  Write-Host ""
  Write-Host "=== [$i/$($Modules.Count)] $m"
  $env:K6_WEB_DASHBOARD = 'true'
  $env:K6_WEB_DASHBOARD_EXPORT = "$out/$m.html"
  & $k6 run -e MODULE=$m -e TEST_TYPE=$TestType -e MEMBER_COUNT=$MemberCount -e VUS=$Vus --summary-export "$out/$m.json" loadtest/modules.k6.js
  if ($LASTEXITCODE -ne 0) { $failed += $m }
}
Remove-Item Env:K6_WEB_DASHBOARD, Env:K6_WEB_DASHBOARD_EXPORT -ErrorAction SilentlyContinue

Write-Host ""
node loadtest/module-table.mjs $out
if ($failed.Count) { Write-Host "Modules that missed a target: $($failed -join ', ')" } else { Write-Host 'Every module met its targets.' }
Write-Host ''
Write-Host 'To show each module as a k6 summary for a screenshot: node loadtest/show-summary.mjs   (Enter = next module)'
