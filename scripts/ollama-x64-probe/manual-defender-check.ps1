<#
.SYNOPSIS
  Does a real Windows x64 Defender leave Ollama's signed runtime alone?

.DESCRIPTION
  The one question the managed-x64 route turns on, and the one no amount of reading settles.
  Self-contained: no repository checkout, no Node, nothing installed. Downloads ~43 MB, writes it
  under %LOCALAPPDATA%, runs it, and reports what Defender did.

  WHY THIS EXISTS AS A SCRIPT AT ALL. A GitHub `windows-latest` runner cannot answer it: that image
  ships Defender's real-time protection off, and even switched on with same-day signatures it does
  not detect EICAR -- the one file every scanner is required to detect. So a hosted runner reports
  "clean" the way an unplugged meter reports zero. This needs a real machine with a Defender nobody
  has touched.

  WHAT IT PROVES, AND WHAT IT DOES NOT.
    proves    : whether Defender flags, quarantines or blocks these signed binaries when they are
                written to disk and when they are executed
    does not  : Smart App Control (a separate consumer feature -- see NOTES), transcription quality
                (already measured on macOS), or what a *different* Defender build does tomorrow.

.PARAMETER WithModel
  Also download the pinned Qwen3-VL-2B (1.5 GB) and load it, so `llama-server.exe` is actually
  executed rather than only `ollama.exe`. Slower, and the stronger test: execution is where
  behaviour monitoring would fire.

.NOTES
  Run in a NORMAL user PowerShell (not elevated) on a machine whose Defender settings you have not
  changed. Do not add exclusions -- an exclusion is the thing this route is trying to avoid needing.

  Smart App Control cannot be tested by this script: it only exists on a clean Windows 11 consumer
  install and is off on most machines. Check yours at
  Windows Security -> App & browser control -> Smart App Control. If it says "On", say so in the
  report -- that is a rarer and more valuable data point than this whole script.

  Untested on Windows by its author (written on a Mac). Read it before you run it.
#>
[CmdletBinding()]
param([switch]$WithModel)

$ErrorActionPreference = 'Stop'
$ZipUrl  = 'https://github.com/ollama/ollama/releases/download/v0.34.0/ollama-windows-amd64.zip'
$Root    = Join-Path $env:LOCALAPPDATA 'x64-defender-check'
$Runtime = Join-Path $Root 'ollama-v0.34.0'
$Port    = 11533
$report  = [ordered]@{}

function Say($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 0. Is the scanner even awake?
Say '0. Does this machine detect anything at all?'
$status = Get-MpComputerStatus
$status | Select-Object AMEngineVersion, AntivirusSignatureVersion, AntivirusSignatureLastUpdated,
                        RealTimeProtectionEnabled, BehaviorMonitorEnabled, IsTamperProtected | Format-List
$report.engineBefore = $status.AMEngineVersion
$report.signatureBefore = $status.AntivirusSignatureVersion

if (-not $status.RealTimeProtectionEnabled) {
  throw "Real-time protection is OFF. Turn it on, or this measures nothing."
}

# EICAR: 68 harmless ASCII bytes published so scanners can be tested without malware. Assembled at
# run time so this script file is not itself a detection.
$avDir = Join-Path $Root 'avcheck'; New-Item -ItemType Directory -Force -Path $avDir | Out-Null
$eicar = Join-Path $avDir 'eicar.com'
$s = 'X5O!P%@AP[4\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
Set-Content -Path $eicar -Value $s -Encoding ASCII -ErrorAction SilentlyContinue
Start-Sleep -Seconds 10
$eicarGone = -not (Test-Path $eicar)
Remove-Item $eicar -Force -ErrorAction SilentlyContinue
"EICAR removed by Defender: $eicarGone"
if (-not $eicarGone) {
  throw "This machine did not remove EICAR. Whatever it says about the binaries below is meaningless."
}
$report.scannerProven = $true

# ---------------------------------------------------------------- 1. Write the binaries
Say '1. Download and extract -- everything except the CUDA directories'
$zip = Join-Path $Root 'ollama.zip'
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
# The download itself is the first thing Defender sees.
Invoke-WebRequest -Uri $ZipUrl -OutFile $zip
if (-not (Test-Path $zip)) { throw 'The zip is gone after download -- Defender took it. THAT IS THE ANSWER.' }
"zip on disk: {0:N0} bytes (expected 1,469,375,054)" -f (Get-Item $zip).Length

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  # Only what a CUDA-less install would hold: ollama.exe, the lib/ollama root, and vulkan.
  $wanted = $archive.Entries | Where-Object {
    $_.Name -and ($_.FullName -eq 'ollama.exe' -or
      ($_.FullName -like 'lib/ollama/*' -and $_.FullName -notlike 'lib/ollama/cuda_v*'))
  }
  foreach ($e in $wanted) {
    $dest = Join-Path $Runtime ($e.FullName -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
  }
  "extracted $($wanted.Count) files"
} finally { $archive.Dispose() }
Remove-Item $zip -Force

# The point of the exercise: are they still there a moment later?
Start-Sleep -Seconds 20
$missing = @()
foreach ($n in 'ollama.exe','lib\ollama\libllama.dll','lib\ollama\libmtmd.dll',
                'lib\ollama\ggml-cpu-haswell.dll','lib\ollama\llama-server.exe') {
  if (-not (Test-Path (Join-Path $Runtime $n))) { $missing += $n }
}
$report.filesQuarantined = $missing
if ($missing.Count) { "QUARANTINED: $($missing -join ', ')" } else { 'all key binaries still on disk' }

Say '1b. Are they the signed Ollama binaries?'
$sig = Get-AuthenticodeSignature (Join-Path $Runtime 'ollama.exe')
"status: $($sig.Status) · signer: $($sig.SignerCertificate.Subject)"
$report.signature = "$($sig.Status)"
"sha256 ollama.exe: $((Get-FileHash (Join-Path $Runtime 'ollama.exe') -Algorithm SHA256).Hash.ToLower())"
'expected         : 1f9b38e594a3e1cffdf606a507ac8660626c0985ee0782dd6b49309153d38080'

# ---------------------------------------------------------------- 2. Execute them
Say '2. Run the server -- execution is where behaviour monitoring would fire'
$models = Join-Path $Root 'models'; New-Item -ItemType Directory -Force -Path $models | Out-Null
$env:OLLAMA_HOST = "127.0.0.1:$Port"; $env:OLLAMA_MODELS = $models
$proc = Start-Process -FilePath (Join-Path $Runtime 'ollama.exe') -ArgumentList 'serve' `
                      -PassThru -NoNewWindow -RedirectStandardError (Join-Path $Root 'serve.log')
$up = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 1
  try { $v = Invoke-RestMethod "http://127.0.0.1:$Port/api/version"; $up = $true; break } catch {}
}
if (-not $up) { "server did NOT answer in 30 s -- check $Root\serve.log (blocked? or CUDA-less start failed?)" }
else { "server answered: version $($v.version) -- and it started with no CUDA directories present" }
$report.serverStarted = $up

if ($WithModel -and $up) {
  Say '2b. Load the pinned 2B, so llama-server.exe runs too'
  $md = Join-Path $models 'qwen3-vl-2b'; New-Item -ItemType Directory -Force -Path $md | Out-Null
  $rev = '52d6c8ffea26cc873ac5ad116f8631268d7eb503'
  $base = "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/$rev"
  Invoke-WebRequest "$base/Qwen3VL-2B-Instruct-Q4_K_M.gguf"        -OutFile (Join-Path $md 'model.gguf')
  Invoke-WebRequest "$base/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf"   -OutFile (Join-Path $md 'mmproj.gguf')
  "FROM $md`nPARAMETER num_ctx 6144" | Set-Content (Join-Path $Root 'Modelfile')
  & (Join-Path $Runtime 'ollama.exe') create defendercheck -f (Join-Path $Root 'Modelfile')
  # A trivial prompt is enough: the point is that llama-server.exe starts and runs.
  Invoke-RestMethod "http://127.0.0.1:$Port/api/generate" -Method Post -TimeoutSec 600 -Body `
    (@{ model='defendercheck'; prompt='hi'; stream=$false; keep_alive=0 } | ConvertTo-Json) | Out-Null
  'llama-server.exe ran'
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Process ollama, llama-server -ErrorAction SilentlyContinue | Stop-Process -Force

# ---------------------------------------------------------------- 3. What did Defender do?
Say '3. Defender, afterwards'
$threats = @(Get-MpThreatDetection -ErrorAction SilentlyContinue)
$known   = @(Get-MpThreat -ErrorAction SilentlyContinue)
$events  = @(Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -ErrorAction SilentlyContinue |
             Where-Object { $_.Id -in 1116, 1117 -and $_.TimeCreated -gt (Get-Date).AddHours(-1) })
$ours = @($threats + $known) | Where-Object { "$($_.Resources)" -match 'x64-defender-check' }

"detections (all time): $($threats.Count) · known threats: $($known.Count) · events 1116/1117 in the last hour: $($events.Count)"
"naming OUR directory : $($ours.Count)"
$ours | Format-List
$report.ourDetections = $ours.Count
$after = Get-MpComputerStatus
$report.engineAfter = $after.AMEngineVersion
$report.signatureAfter = $after.AntivirusSignatureVersion

Say 'VERDICT'
if ($ours.Count -eq 0 -and $report.filesQuarantined.Count -eq 0 -and $up) {
  'CLEAN -- Defender left the signed Ollama runtime alone on this machine, this day.' }
else { 'FLAGGED -- see above. This is the finding the route was waiting for.' }

$out = Join-Path $Root 'report.json'
$report | ConvertTo-Json -Depth 4 | Set-Content $out
"`nReport: $out"
"Windows: $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).Version)"
"Smart App Control: check Windows Security -> App & browser control, and report what it says."
"`nTo undo everything: Remove-Item -Recurse -Force '$Root'"
