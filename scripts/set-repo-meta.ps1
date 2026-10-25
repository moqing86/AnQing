# set-repo-meta.ps1 - 设置 GitHub 仓库简介与 topics（2026-10）
# 凭据来源：git 的 credential helper（推送时登录过的那份），不会打印 token 本身。
$ErrorActionPreference = 'Stop'
$repo = 'moqing86/AnQing'

# 1) 从 credential helper 取凭据
$req = "protocol=https`nhost=github.com`n`n"
$res = $req | git credential fill 2>$null
$token = ($res | Select-String '^password=' ).Line -replace '^password=', ''
$user  = ($res | Select-String '^username=' ).Line -replace '^username=', ''
if (-not $token) { Write-Error '拿不到 GitHub 凭据（先在仓库里 git push 一次让它登录）'; exit 1 }
Write-Host ("凭据: " + $user + " / token " + $token.Length + " 字符（不打印）")

$headers = @{ Authorization = "Bearer $token"; 'User-Agent' = 'anqing'; 'Accept' = 'application/vnd.github+json' }
$ps = @{ SkipCertificateCheck = $true }

# 2) 描述 + 主页
$body = @{
  description = 'Offline on-device AI companion for Android — local LLM chat + local TTS/ASR, no cloud, no server.'
  homepage    = ''
} | ConvertTo-Json
try {
  Invoke-RestMethod @ps -Method Patch -Uri "https://api.github.com/repos/$repo" -Headers $headers -Body $body | Out-Null
  Write-Host '✅ 简介已更新' -ForegroundColor Green
} catch { Write-Host ("简介失败: " + $_.Exception.Message) -ForegroundColor Yellow }

# 3) topics
$topics = @('android','offline','ai-companion','sherpa-onnx','tts','asr','privacy','nodejs-mobile','on-device')
$tb = @{ names = $topics } | ConvertTo-Json
try {
  $r = Invoke-RestMethod @ps -Method Put -Uri "https://api.github.com/repos/$repo/topics" -Headers $headers -Body $tb
  Write-Host ('✅ topics: ' + ($r.names -join ', ')) -ForegroundColor Green
} catch { Write-Host ("topics 失败: " + $_.Exception.Message) -ForegroundColor Yellow }

# 4) 回读确认
try {
  $q = Invoke-RestMethod @ps -Uri "https://api.github.com/repos/$repo" -Headers $headers
  Write-Host ('当前简介：' + $q.description)
  Write-Host ('当前 topics：' + ($q.topics -join ', '))
} catch { Write-Host '回读失败（不影响已生效的设置）' }
