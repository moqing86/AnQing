# Stage the engine assets that get baked into the APK (assets/engine/**).
# Pure ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
#   master (product/xiaoan-mobile)  ->  apk/assets/engine/{server.js,config.json,her/**,public/**}
#   seed   (product/xiaoan-mobile/seed/*.json)  ->  apk/assets/engine/data/*.jsonl   (first-run seed only)
#
# The engine (Engine.java) copies these into filesDir/engine on every start:
#   * code + heart files are overwritten (upgrades take effect)
#   * data/ and memory.txt are only written when missing (her memory is never clobbered)

$ErrorActionPreference = 'Stop'

$MASTER = 'D:\dsh\Project\project2\anqing\common\product\xiaoan-mobile'
$APK    = Join-Path $MASTER 'apk'
$DST    = Join-Path $APK 'assets\engine'
$SEED   = Join-Path $MASTER 'seed'
$PHONE_CFG = 'D:\dsh\Project\project2\anqing\common\scripts\config.phone.json'
$APP_PORT = 3083

$utf8 = New-Object System.Text.UTF8Encoding($false)
function WriteUtf8($path, $text) {
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

# ---- clean staging dir (explicit path only) ----
if (Test-Path $DST) {
  if (-not $DST.EndsWith('\engine')) { throw "refusing to clean unexpected path: $DST" }
  Remove-Item -LiteralPath $DST -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $DST | Out-Null

# ---- engine code + heart files ----
Copy-Item (Join-Path $MASTER 'server.js') (Join-Path $DST 'server.js') -Force
foreach ($d in @('her', 'public')) {
  $src = Join-Path $MASTER $d
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $DST $d) -Recurse -Force
  }
}

# ---- config.json (app flavour: own port, real key, correct contact name) ----
$phone = ([System.IO.File]::ReadAllText($PHONE_CFG, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
$XIAOAN = [string][char]0x5C0F + [string][char]0x5B89   # U+5C0F U+5B89 = "xiao an"
$cfg = [ordered]@{
  apiKey          = $phone.apiKey
  model           = $phone.model
  fallbackModel   = $phone.fallbackModel
  baseUrl         = $phone.baseUrl
  port            = $APP_PORT
  historyMax      = $phone.historyMax
  contextChars    = $phone.contextChars
  proactiveMinMin = $phone.proactiveMinMin
  proactiveMaxMin = $phone.proactiveMaxMin
  passwordHash    = $phone.passwordHash
  contacts        = @(
    [ordered]@{ id = 'xiaoan'; name = $XIAOAN; avatar = 'avatar.jpg'; proactive = $true }
  )
}
$cfgJson = $cfg | ConvertTo-Json -Depth 6
WriteUtf8 (Join-Path $DST 'config.json') $cfgJson

# ---- 语音模型（ZipVoice 克隆，~149 MB）：整包塞进 assets/tts，App 首启解压 ----
# 单独放 assets\tts（不在 assets\engine 下）——因为本脚本每次都会清空 engine 目录
$TTS_SRC = Join-Path $MASTER 'tts\tts.zip'
$TTS_DST = Join-Path $APK 'assets\tts'
if (Test-Path $TTS_SRC) {
  if (-not (Test-Path $TTS_DST)) { New-Item -ItemType Directory -Force -Path $TTS_DST | Out-Null }
  Copy-Item $TTS_SRC (Join-Path $TTS_DST 'tts.zip') -Force
  $mb = [math]::Round((Get-Item $TTS_SRC).Length / 1MB, 1)
  Write-Host ("[assets] tts.zip -> assets\tts\  (" + $mb + " MB)")
} else {
  Write-Host "[assets] 警告：没有 tts\tts.zip，语音会退回手机自带 TTS"
}

# ---- ASR model (SenseVoice int8, ~157 MB) -> assets/asr, extracted on first use ----
# This phone has no system speech recognition service, so "hold to talk" needs its own model.
$ASR_SRC = Join-Path $MASTER 'asr\asr.zip'
$ASR_DST = Join-Path $APK 'assets\asr'
if (Test-Path $ASR_SRC) {
  if (-not (Test-Path $ASR_DST)) { New-Item -ItemType Directory -Force -Path $ASR_DST | Out-Null }
  Copy-Item $ASR_SRC (Join-Path $ASR_DST 'asr.zip') -Force
  $amb = [math]::Round((Get-Item $ASR_SRC).Length / 1MB, 1)
  Write-Host ("[assets] asr.zip -> assets\asr\  (" + $amb + " MB)")
} else {
  Write-Host "[assets] NOTE: no asr\asr.zip - hold-to-talk will be hidden in the UI"
}

# ---- seed: history + marks as JSONL (first run only) ----
$seedHist = Join-Path $SEED 'history-xiaoan.json'
if (Test-Path $seedHist) {
  $h = ([System.IO.File]::ReadAllText($seedHist, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
  $lines = @()
  foreach ($m in $h.history) {
    $lines += ([ordered]@{ id = $m.id; role = $m.role; text = $m.text; t = $m.t } | ConvertTo-Json -Compress)
  }
  WriteUtf8 (Join-Path $DST 'data\history-xiaoan.jsonl') (($lines -join "`n") + "`n")
  Write-Host ("[assets] seeded history: " + $lines.Count + " messages")
}

$seedMarks = Join-Path $SEED 'marks-xiaoan.json'
if (Test-Path $seedMarks) {
  $mk = ([System.IO.File]::ReadAllText($seedMarks, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
  $mlines = @()
  foreach ($m in $mk.marks) { $mlines += ($m | ConvertTo-Json -Compress) }
  if ($mlines.Count -gt 0) {
    WriteUtf8 (Join-Path $DST 'data\marks-xiaoan.jsonl') (($mlines -join "`n") + "`n")
    Write-Host ("[assets] seeded marks: " + $mlines.Count)
  }
}

Write-Host '[assets] staged:'
Get-ChildItem $DST -Recurse -File | ForEach-Object { "  " + $_.FullName.Replace($DST + '\', '') + "  " + $_.Length }
$total = (Get-ChildItem $DST -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[assets] total " + [math]::Round($total / 1KB, 1) + " KB")
