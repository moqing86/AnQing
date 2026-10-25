# make-demo-shots.ps1 - 生成脱敏截图（2026-10）
# 思路：把真引擎/真页面搬到临时目录，塞**编造的演示对话**，本地跑起来用 Edge 无头截图。
# 用户真实聊天记录 / 记忆 / 头像一律不参与。
$ErrorActionPreference = 'Stop'
$repo = 'D:\dsh\Project\anqing-open'
$prod = 'D:\dsh\Project\project2\anqing\common\product\xiaoan-mobile'
$shop = Join-Path $env:TEMP 'anqing-uishop'
$port = 3999

if (Test-Path $shop) { Remove-Item $shop -Recurse -Force }
New-Item -ItemType Directory -Path $shop | Out-Null
Copy-Item (Join-Path $prod 'server.js') $shop
Copy-Item (Join-Path $prod 'public') (Join-Path $shop 'public') -Recurse
New-Item -ItemType Directory -Path (Join-Path $shop 'her\demo') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $shop 'data') -Force | Out-Null

# 演示人格（虚构、简短）
Set-Content (Join-Path $shop 'her\demo\persona.txt') -Encoding utf8 -Value '你是安，一个住在手机里的女孩。说话短、口语化、偶尔俏皮。'
Set-Content (Join-Path $shop 'her\demo\qing.txt') -Encoding utf8 -Value '你和他在一个安静的小屋里聊天。'
Set-Content (Join-Path $shop 'her\demo\secret.txt') -Encoding utf8 -Value '你今天在窗边看书。'

# 演示配置
$cfg = @{
  apiKey = 'DEMO_KEY'
  baseUrl = 'https://open.bigmodel.cn/api/paas/v4'
  model = 'glm-4.5-flash'
  fallbackModel = 'glm-4-flash'
  passwordHash = '22a877aa8637c96423b61602900efa7d9f0c46f2cdd3f34eabcce942a34985f7'
  port = $port
  weather = @{ place = '潍坊' }
  contacts = @(@{ id = 'demo'; name = '安'; avatar = 'avatar.png'; proactive = $false })
} | ConvertTo-Json -Depth 6
Set-Content (Join-Path $shop 'config.json') -Value $cfg -Encoding utf8

# 中性头像（渐变方块，不用任何真人/角色图）
$sharp = 'C:/Users/Lenovo/.dsh/profiles/node_modules/sharp'
$avatarJs = @"
const sharp = require('$sharp');
sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 34, g: 48, b: 38 } } })
  .composite([{ input: Buffer.from('<svg width="256" height="256"><defs><radialGradient id="g" cx="35%" cy="30%" r="80%"><stop offset="0%" stop-color="#8fd3a8"/><stop offset="100%" stop-color="#1b2a20"/></radialGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="128" cy="100" r="42" fill="#dcebe1" opacity=".85"/><rect x="72" y="158" width="112" height="64" rx="32" fill="#dcebe1" opacity=".8"/></svg>') }])
  .png().toFile(process.argv[2]).then(() => console.log('avatar ok'));
"@
$avatarJs | Set-Content (Join-Path $shop '_avatar.mjs') -Encoding utf8
node (Join-Path $shop '_avatar.mjs') (Join-Path $shop 'public\avatar.png')

# 演示对话（全部虚构）
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$lines = @(
  @{ role='assistant'; text='（把茶往你那边推了推）……回来了？'; voice=0 },
  @{ role='user'; text='刚到家，累死我了'; voice=0 },
  @{ role='assistant'; text='那就先别说话，坐一会儿。'; voice=1 },
  @{ role='assistant'; text='茶还热着。'; voice=0 },
  @{ role='user'; text='你今天干嘛了'; voice=0 },
  @{ role='assistant'; text='（翻了一页书）上午在窗边看书，下午睡了一觉。'; voice=0 },
  @{ role='assistant'; text='外面下雨了，你淋到没有？'; voice=0 },
  @{ role='user'; text='没，我打车回来的'; voice=0 },
  @{ role='assistant'; text='哦。那还行。'; voice=0 },
  @{ role='user'; text='晚上想你陪我聊会儿'; voice=0 },
  @{ role='assistant'; text='嗯，我在呢。'; voice=0 },
  @{ role='assistant'; text='（敲了敲屏幕）你先去洗个澡，回来再说。'; voice=0 }
)
$i = 0
$rows = foreach ($l in $lines) {
  $i++
  [pscustomobject]@{ id = "demo-$i"; role = $l.role; text = $l.text; t = $now + $i * 60000; voice = $l.voice } | ConvertTo-Json -Compress
}
Set-Content (Join-Path $shop 'data\history-demo.jsonl') -Value ($rows -join "`n") -Encoding utf8

# 起服务
$env:PORT = "$port"
$srv = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $shop -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 5
  Write-Host ("服务已起: " + ($h | ConvertTo-Json -Compress))
} catch { Write-Host '服务没起来'; if ($srv) { $srv | Stop-Process -Force }; exit 1 }

# 找 Edge / Chrome
$browsers = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ }
if (-not $browsers) { Write-Host '没找到 Edge/Chrome，跳过截图'; $srv | Stop-Process -Force; exit 0 }
$exe = $browsers[0]
Write-Host ("浏览器: " + $exe)

# 截图输出目录
$outDir = Join-Path $repo 'docs'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$shots = @(
  @{ name = 'screenshot-chat.png';  url = "/?app=unlocked" },
  @{ name = 'screenshot-list.png';  url = "/?app=unlocked" }
)
# 页面要先进聊天：用 hash 不方便，直接截首页（列表）；聊天用第二张单独做
$tmpProfile = Join-Path $env:TEMP ('anqing-edge-' + [guid]::NewGuid().ToString('N').Substring(0,8))
foreach ($s in $shots) {
  $png = Join-Path $outDir $s.name
  $args = @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    "--user-data-dir=$tmpProfile",
    "--screenshot=$png", '--window-size=430,900',
    '--virtual-time-budget=6000',
    ("http://127.0.0.1:$port" + $s.url)
  )
  & $exe @args 2>$null | Out-Null
  Start-Sleep -Milliseconds 800
  if (Test-Path $png) { Write-Host ("✅ " + $s.name + "  " + [math]::Round((Get-Item $png).Length/1KB) + " KB") } else { Write-Host ("❌ " + $s.name) }
}
if (Test-Path $tmpProfile) { Remove-Item $tmpProfile -Recurse -Force -ErrorAction SilentlyContinue }
$srv | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host ('截图目录: ' + $outDir)
