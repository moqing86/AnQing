# Build a signed APK by hand (no Gradle): aapt2 -> javac -> jar -> d8 -> aapt add -> zipalign -> apksigner
# Pure ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
# Usage:
#   powershell -File build-apk.ps1 -ProjectDir <dir> [-ApkName anqing-signed.apk] [-OutDir <dir>]
#
# Expected project layout:
#   <ProjectDir>\AndroidManifest.xml
#   <ProjectDir>\src\**\*.java
#   <ProjectDir>\res\...            (optional)
#   <ProjectDir>\assets\...         (optional, packaged as assets/)
#   <ProjectDir>\jniLibs\<abi>\*.so  (optional, packaged as lib/<abi>/)

param(
  [Parameter(Mandatory = $true)][string]$ProjectDir,
  [string]$ApkName = 'app-signed.apk',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$SDK         = 'D:\dsh\Project\project2\anqing\common\toolchain\android-sdk'
$BT          = Join-Path $SDK 'android-14'
$ANDROID_JAR = Join-Path $SDK 'android-34\android.jar'
$KEYS        = 'D:\dsh\Project\project2\anqing\common\keys'
$AAPT2       = Join-Path $BT 'aapt2.exe'
$AAPT        = Join-Path $BT 'aapt.exe'
$ZIPALIGN    = Join-Path $BT 'zipalign.exe'
$APKSIGNER   = Join-Path $BT 'apksigner.bat'
$D8          = Join-Path $BT 'd8.bat'
$MIN_API     = 24

$PROJ = (Resolve-Path $ProjectDir).Path
if ($OutDir -eq '') { $OutDir = $PROJ }
$BUILD = Join-Path $PROJ 'build'

foreach ($p in @($AAPT2, $AAPT, $ZIPALIGN, $APKSIGNER, $D8, $ANDROID_JAR)) {
  if (-not (Test-Path $p)) { throw "missing tool: $p" }
}

function Step($msg) { Write-Host ("[build] " + $msg) }

# Windows PowerShell 5.1 turns a native command's stderr into a terminating error while
# $ErrorActionPreference is 'Stop' (javac's "deprecated API" note is a normal case).
# Run native tools with Continue and judge them by their exit code.
function Invoke-Native([scriptblock]$block, [string]$what) {
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $block } finally { $ErrorActionPreference = $eap }
  if ($LASTEXITCODE -ne 0) { throw ($what + ' failed (exit ' + $LASTEXITCODE + ')') }
}

# ---- clean previous build artifacts (explicit path only) ----
if (Test-Path $BUILD) {
  if (-not $BUILD.EndsWith('\build')) { throw "refusing to clean unexpected path: $BUILD" }
  Remove-Item -LiteralPath $BUILD -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $BUILD, (Join-Path $BUILD 'gen'), (Join-Path $BUILD 'stage') | Out-Null

# ---- 1. resources ----
$resDir = Join-Path $PROJ 'res'
$resZip = Join-Path $BUILD 'res.zip'
$hasRes = (Test-Path $resDir) -and (@(Get-ChildItem $resDir -Recurse -File).Count -gt 0)
if ($hasRes) {
  Step 'aapt2 compile'
  & $AAPT2 compile --dir $resDir -o $resZip
  if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }
}

# ---- 2. link (resources + manifest + assets) ----
Step 'aapt2 link'
$baseApk = Join-Path $BUILD 'base.apk'
$linkArgs = @('link', '-o', $baseApk, '-I', $ANDROID_JAR, '--manifest', (Join-Path $PROJ 'AndroidManifest.xml'), '--java', (Join-Path $BUILD 'gen'), '--auto-add-overlay')
if ($hasRes) { $linkArgs += @('-R', $resZip) }
# NOTE: assets are NOT added here on purpose. aapt2 run on Windows writes asset entry names
# with backslashes (assets\engine\server.js), which Android's AssetManager cannot resolve.
# They are staged and added below with forward slashes instead.
& $AAPT2 @linkArgs
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

# ---- 3. javac ----
Step 'javac'
$javaFiles = @(Get-ChildItem (Join-Path $PROJ 'src') -Recurse -Filter *.java -ErrorAction SilentlyContinue) +
             @(Get-ChildItem (Join-Path $BUILD 'gen') -Recurse -Filter *.java -ErrorAction SilentlyContinue)
if ($javaFiles.Count -eq 0) { throw 'no java sources found' }
$classDir = Join-Path $BUILD 'classes'
New-Item -ItemType Directory -Force -Path $classDir | Out-Null
# 第三方 jar（sherpa-onnx API + kotlin-stdlib）放 libs\，编译时要做 classpath
$libsDir = Join-Path $PROJ 'libs'
$cp = ''
if (Test-Path $libsDir) {
  $jars = @(Get-ChildItem $libsDir -Filter *.jar | ForEach-Object { $_.FullName })
  if ($jars.Count -gt 0) { $cp = ($jars -join ';'); Step ('javac classpath: ' + $jars.Count + ' jar') }
}
$javacArgs = @('-encoding', 'UTF-8', '-nowarn', '-source', '8', '-target', '8', '-bootclasspath', $ANDROID_JAR)
if ($cp -ne '') { $javacArgs += @('-classpath', $cp) }
$javacArgs += '-d'; $javacArgs += $classDir
$javacArgs += @($javaFiles | ForEach-Object { $_.FullName })
Invoke-Native { & javac @javacArgs } 'javac'
# ---- 4. d8 (takes an explicit class-file list; no jar tool needed) ----
Step 'd8'
$classFiles = @(Get-ChildItem $classDir -Recurse -Filter *.class | ForEach-Object { $_.FullName })
if ($classFiles.Count -eq 0) { throw 'javac produced no classes' }
# 第三方 jar（sherpa-onnx 的 Kotlin API + kotlin-stdlib）一起打进 dex
$libJars = @()
$libsDir = Join-Path $PROJ 'libs'
if (Test-Path $libsDir) { $libJars = @(Get-ChildItem $libsDir -Filter *.jar | ForEach-Object { $_.FullName }) }
if ($libJars.Count -gt 0) { Step ('d8 附带 ' + $libJars.Count + ' 个 jar') }
$dexOut = Join-Path $BUILD 'dexout'
New-Item -ItemType Directory -Force -Path $dexOut | Out-Null   # d8 requires the output dir to exist
Invoke-Native { & $D8 --lib $ANDROID_JAR --min-api $MIN_API --output $dexOut @classFiles @libJars } 'd8'

# ---- 5. stage: dex + native libs + the apk itself live in ONE dir, added with relative paths ----
# aapt's "add" resolves the file argument against the apk's own directory, not the cwd
# (verified empirically), so everything must sit next to the apk.
Step 'staging dex + native libs'
$stage = Join-Path $BUILD 'stage'
Copy-Item (Join-Path $dexOut 'classes.dex') (Join-Path $stage 'classes.dex') -Force

$jniDir = Join-Path $PROJ 'jniLibs'
$addList = @('classes.dex')

# assets: copied into the stage dir and added with forward-slash entry names
$assetsDir = Join-Path $PROJ 'assets'
if (Test-Path $assetsDir) {
  $assetsStage = Join-Path $stage 'assets'
  New-Item -ItemType Directory -Force -Path $assetsStage | Out-Null
  Copy-Item (Join-Path $assetsDir '*') $assetsStage -Recurse -Force
  foreach ($f in (Get-ChildItem $assetsStage -Recurse -File)) {
    $rel = 'assets/' + $f.FullName.Substring($assetsStage.Length + 1).Replace('\', '/')
    $addList += $rel
  }
}

if (Test-Path $jniDir) {
  foreach ($abi in (Get-ChildItem $jniDir -Directory)) {
    $dst = Join-Path $stage ('lib\' + $abi.Name)
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    foreach ($so in (Get-ChildItem $abi.FullName -File -Filter *.so)) {
      Copy-Item $so.FullName (Join-Path $dst $so.Name) -Force
      $addList += ('lib/' + $abi.Name + '/' + $so.Name)
    }
  }
}
$stagedApk = Join-Path $stage 'app.apk'
Copy-Item $baseApk $stagedApk -Force

Push-Location $stage
foreach ($entry in $addList) {
  Step ('aapt add ' + $entry)
  & $AAPT add 'app.apk' $entry | Out-Null
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw ('aapt add failed: ' + $entry) }
}
Pop-Location

# ---- 6. zipalign + sign ----
Step 'zipalign'
$aligned = Join-Path $BUILD 'aligned.apk'
& $ZIPALIGN -p -f 4 $stagedApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Step 'apksigner'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outPath = Join-Path $OutDir $ApkName
Invoke-Native { & $APKSIGNER sign --key (Join-Path $KEYS 'anqing.key.der') --cert (Join-Path $KEYS 'anqing.cert.der') --out $outPath $aligned } 'apksigner'

Step 'verify'
& $APKSIGNER verify --print-certs $outPath 2>&1 | Select-Object -First 4

$size = [math]::Round((Get-Item $outPath).Length / 1MB, 2)
Write-Host ("[build] OK -> " + $outPath + "  (" + $size + " MB)")
