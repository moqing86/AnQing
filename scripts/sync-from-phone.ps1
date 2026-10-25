# 安倾 · 把手机上的对话拉回电脑归档
#
#   pwsh -File sync-from-phone.ps1                 # 全部联系人
#   pwsh -File sync-from-phone.ps1 -Contact xiaoan # 只拉一个
#
# 走 HTTP（adb forward tcp:3083），不需要 root / run-as。
# 产物：
#   anqing\roles\<role>\chats\history-<cid>-<stamp>.jsonl   原始快照
#   anqing\roles\<role>\chats\history-<cid>-<stamp>.txt     人看的版本
#   anqing\roles\<role>\chats\history-<cid>-latest.jsonl    最新一份（便于 diff）
#   anqing\roles\<role>\chats\marks-<cid>.jsonl             人格调校信号（♥ / ✕）
#   anqing\roles\<role>\chats\memory-<cid>.txt              她记着的事
#   anqing\roles\<role>\chats\exports\*.jsonl               手机上手动导出的那一批
#
# Pure ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI).

param([string]$Contact = '')

$ErrorActionPreference = 'Stop'

$ADB     = 'D:\dsh\Project\project2\anqing\common\toolchain\platform-tools\platform-tools\adb.exe'
$BASE    = 'http://127.0.0.1:3083'
$ROLES   = 'D:\dsh\Project\project2\anqing\roles'
$utf8    = New-Object System.Text.UTF8Encoding($false)

function WriteU8($path, $text) {
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

function Get-Api($path) {
  $raw = & curl.exe -s -m 30 "$BASE$path"
  if (-not $raw) { throw ("no answer from " + $path + " (is the app awake?)") }
  return ($raw | ConvertFrom-Json)
}

function Post-Api($path) {
  $raw = & curl.exe -s -m 40 -X POST "$BASE$path"
  if (-not $raw) { throw ("no answer from " + $path) }
  return ($raw | ConvertFrom-Json)
}

# 手机连着吗？引擎醒着吗？
& $ADB forward tcp:3083 tcp:3083 | Out-Null
$health = Get-Api '/api/health'
if (-not $health.ok) { throw 'engine not healthy' }
Write-Host '[sync] 引擎在'

$contacts = (Get-Api '/api/contacts').contacts
if ($Contact -ne '') { $contacts = $contacts | Where-Object { $_.id -eq $Contact } }
if (-not $contacts) { throw ('no such contact: ' + $Contact) }

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$rows = @()

foreach ($c in $contacts) {
  $cid = $c.id
  $roleDir = Join-Path $ROLES $cid
  # 角色目录按 id 命名（xiaoan -> roles\xiaoan）
  $chats = Join-Path $roleDir 'chats'
  New-Item -ItemType Directory -Force -Path $chats | Out-Null

  $hist  = Get-Api ('/api/history?cid=' + $cid)
  $marks = Get-Api ('/api/marks?cid=' + $cid)
  $brain = Get-Api ('/api/brain?cid=' + $cid)

  $jsonl = ($hist.history | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 }) -join "`n"
  if ($jsonl -ne '') { $jsonl += "`n" }
  WriteU8 (Join-Path $chats ('history-' + $cid + '-' + $stamp + '.jsonl')) $jsonl
  WriteU8 (Join-Path $chats ('history-' + $cid + '-latest.jsonl')) $jsonl

  # 人看的版本
  $lines = @()
  foreach ($e in $hist.history) {
    $d = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$e.t).ToOffset([TimeSpan]::FromHours(8))
    $who = if ($e.role -eq 'user') { '小倾' } else { $c.name }
    $line = if ($e.type -eq 'transfer') { '[transfer ' + $e.amount + ' ' + $e.note + ']' } else { [string]$e.text }
    $lines += ($d.ToString('yyyy-MM-dd HH:mm') + '  ' + $who + ':' + $line)
  }
  WriteU8 (Join-Path $chats ('history-' + $cid + '-' + $stamp + '.txt')) (($lines -join "`n") + "`n")

  if ($marks.marks) {
    $mk = ($marks.marks | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 }) -join "`n"
    WriteU8 (Join-Path $chats ('marks-' + $cid + '.jsonl')) ($mk + "`n")
  }
  if ($brain.memory) { WriteU8 (Join-Path $chats ('memory-' + $cid + '.txt')) $brain.memory }

  # 手机上手导出的那批
  $expDir = Join-Path $chats 'exports'
  New-Item -ItemType Directory -Force -Path $expDir | Out-Null
  $got = 0
  foreach ($f in (Get-Api '/api/exports').files) {
    $dst = Join-Path $expDir $f
    if (Test-Path $dst) { continue }
    & curl.exe -s -m 30 -o $dst ("$BASE/api/export-file?name=" + $f)
    $got++
  }

  $loveN = @($marks.marks | Where-Object { $_.mark -eq 'love' }).Count
  $mehN  = @($marks.marks | Where-Object { $_.mark -eq 'meh' }).Count
  $rows += [pscustomobject]@{
    contact = $cid; msgs = @($hist.history).Count; love = $loveN; meh = $mehN
    newExports = $got; dir = $chats
  }
}

Write-Host ''
$rows | Format-Table -AutoSize
Write-Host '[sync] 归档完成。下一步（要人做的）：读 marks（♥ 学语气 / ✕ 避雷）与最新对话，更新 roles\<cid>\<cid>-profile.md'
