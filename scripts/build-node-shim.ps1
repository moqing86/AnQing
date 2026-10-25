# Build libxiaoan_node.so: the JNI glue that lets the app call node::Start inside libnode.so.
# Pure ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
# Usage: powershell -File build-node-shim.ps1 [-NdkDir <path>]
#
# Requires the Android NDK (clang++ for aarch64-linux-android).

param(
  [string]$NdkDir = 'D:\dsh\Project\project2\anqing\common\toolchain\android-ndk-r25c'
)

$ErrorActionPreference = 'Stop'

$PROJ = 'D:\dsh\Project\project2\anqing\common\product\xiaoan-mobile\apk'
$JNI  = Join-Path $PROJ 'jni'
$OUT  = Join-Path $PROJ 'jniLibs\arm64-v8a'
$SRC  = Join-Path $JNI 'node_shim.cpp'

$toolchains = Join-Path $NdkDir 'toolchains\llvm\prebuilt'
if (-not (Test-Path $toolchains)) { throw "NDK not found at $NdkDir" }
$hostDir = (Get-ChildItem $toolchains -Directory | Select-Object -First 1).FullName
$CLANG   = Join-Path $hostDir 'bin\clang++.cmd'
if (-not (Test-Path $CLANG)) { $CLANG = Join-Path $hostDir 'bin\clang++.exe' }
if (-not (Test-Path $CLANG)) { throw "clang++ not found under $hostDir\bin" }
$SYSROOT = Join-Path $hostDir 'sysroot'

New-Item -ItemType Directory -Force -Path $OUT | Out-Null

Write-Host ("[shim] clang++ = " + $CLANG)
$LIBNODE = Join-Path $OUT 'libnode.so'
if (-not (Test-Path $LIBNODE)) { throw "libnode.so missing at $LIBNODE" }
# link against libnode.so by path: -L/-l resolution proved unreliable through PowerShell arg passing
& $CLANG --target=aarch64-linux-android24 --sysroot=$SYSROOT -shared -fPIC -O2 -fno-exceptions -fno-rtti -o (Join-Path $OUT 'libxiaoan_node.so') $SRC -llog $LIBNODE
if ($LASTEXITCODE -ne 0) { throw 'clang++ failed' }

$so = Join-Path $OUT 'libxiaoan_node.so'
Write-Host ("[shim] OK -> " + $so + "  (" + (Get-Item $so).Length + " bytes)")
