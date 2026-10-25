# set-password.ps1 - 改掉 App 的默认密码（2026-10）
#
# 这个 App 有两把"锁"，用的是**同一个密码的 sha256**：
#   ① 原生锁：app/src/com/xiaoan/app/MainActivity.java 里的 PW_HASH（冷启动要输）
#   ② 页面锁：config.json 里的 passwordHash（浏览器直开 127.0.0.1:3083 时要输）
# 本脚本把两处一起改掉，然后再重新打包。
#
# 用法：
#   powershell -File scripts/set-password.ps1 -Password "你的新密码"
#   powershell -File scripts/set-password.ps1 -Password "你的新密码" -Config "config.json"

param(
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$JavaFile = 'app/src/com/xiaoan/app/MainActivity.java',
  [string]$Config = 'config.json'
)

$ErrorActionPreference = 'Stop'

# 1) 算 sha256（UTF-8，无 BOM）
$bytes = [System.Text.Encoding]::UTF8.GetBytes($Password)
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
Write-Host ("新密码的 sha256: " + $hash) -ForegroundColor Cyan

# 2) 改 Java（原生锁）
if (Test-Path $JavaFile) {
  $t = Get-Content $JavaFile -Raw -Encoding UTF8
  $new = [regex]::Replace($t, 'private static final String PW_HASH = "[0-9a-f]{64}"', ('private static final String PW_HASH = "' + $hash + '"'))
  if ($new -eq $t) { Write-Warning "Java 里没找到 PW_HASH（路径对吗：$JavaFile）" }
  else { Set-Content $JavaFile -Value $new -Encoding utf8 -NoNewline; Write-Host "✅ 已更新 $JavaFile" -ForegroundColor Green }
} else {
  Write-Warning "没找到 $JavaFile（先 cd 到仓库根目录再跑）"
}

# 3) 改 config.json（页面锁）
if (Test-Path $Config) {
  $c = Get-Content $Config -Raw -Encoding UTF8
  $c2 = [regex]::Replace($c, '"passwordHash"\s*:\s*"[0-9a-f]*"', ('"passwordHash": "' + $hash + '"'))
  if ($c2 -eq $c) { Write-Warning "config 里没找到 passwordHash" }
  else { Set-Content $Config -Value $c2 -Encoding utf8 -NoNewline; Write-Host "✅ 已更新 $Config" -ForegroundColor Green }
} else {
  Write-Host "（没有 $Config —— 如果还没建，先: cp config.example.json config.json）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "下一步：重新打包（scripts/prepare-app-assets.ps1 → scripts/build-apk.ps1）" -ForegroundColor Cyan
