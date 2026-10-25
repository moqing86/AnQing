# 推送脚本（2026-10 · 你在终端里跑，或者把 token 给我代跑）
# 用法：$env:GH_TOKEN="ghp_xxx"; .\push-public.ps1 -Repo "anqing"
# 说明：本机加速器做了 TLS 中间代理 → 用 schannel（走 Windows 证书库）能过；仍报错就临时关校验。

param(
  [string]$Repo = 'anqing',
  [string]$User = ''
)
$ErrorActionPreference = 'Stop'
$dir = 'D:\dsh\Project\anqing-open'
Set-Location $dir

if (-not $env:GH_TOKEN) { Write-Host '请先设置 $env:GH_TOKEN（GitHub Personal Access Token，勾 repo / Contents 读写）' -ForegroundColor Yellow; exit 1 }
if (-not $User) {
  $u = (Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers @{ Authorization = "Bearer $env:GH_TOKEN"; 'User-Agent' = 'anqing' })
  $User = $u.login
}
Write-Host "仓库：$User/$Repo"

# 1) 建仓库（已存在会报 422，忽略）
try {
  Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' `
    -Headers @{ Authorization = "Bearer $env:GH_TOKEN"; 'User-Agent' = 'anqing'; 'Accept' = 'application/vnd.github+json' } `
    -Body (@{ name = $Repo; description = 'Offline AI companion app: on-device LLM chat + local TTS/ASR, runs entirely on the phone'; private = $false } | ConvertTo-Json) | Out-Null
  Write-Host '✅ 仓库已创建'
} catch {
  Write-Host ('创建仓库返回：' + $_.Exception.Message + '（若已存在可忽略）')
}

# 2) 推送（用 schannel 走 Windows 证书库）
git config http.sslBackend schannel
git remote remove origin 2>$null
git remote add origin "https://$User`:$env:GH_TOKEN@github.com/$User/$Repo.git"
git branch -M main
git push -u origin main 2>&1 | ForEach-Object { Write-Host $_ }

# 3) 收尾：把带 token 的 remote 换回干净地址（别把 token 留在仓库配置里）
git remote set-url origin "https://github.com/$User/$Repo.git"
Write-Host "`n完成：https://github.com/$User/$Repo"
