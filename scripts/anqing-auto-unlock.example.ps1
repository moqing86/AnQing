# Anqing App remote auto-unlock (for assistant remote verification)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File xiaoan-auto-unlock.ps1
$adb = "D:\dsh\Project\project2\anqing\common\toolchain\platform-tools\platform-tools\adb.exe"
$PASSWORD = $env:ANQING_APP_PASSWORD

# 0. cold start
& $adb shell am force-stop com.xiaoan.app 2>$null | Out-Null
Start-Sleep -Seconds 3

# 1. launch app until it is really foreground (Termux keeps stealing focus)
$up = $false
for ($try = 0; $try -lt 6; $try++) {
    & $adb shell am start -n com.xiaoan.app/.MainActivity 2>$null | Out-Null
    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Seconds 1
        $top = (& $adb shell "dumpsys activity activities 2>/dev/null | grep topResumedActivity" 2>$null | Out-String)
        if ($top -match 'com\.xiaoan\.app') { $up = $true; break }
    }
    if ($up) { break }
    Write-Host ("retry " + $try + ": app not foreground yet")
}
if (-not $up) { Write-Host "APP_FAILED_TO_FOREGROUND"; exit 1 }
Start-Sleep -Seconds 1

# 2. dump UI, find password field and enter button
& $adb shell uiautomator dump /sdcard/ui.xml 2>$null | Out-Null
& $adb pull /sdcard/ui.xml "$env:TEMP\xiaoan-ui.xml" 2>$null | Out-Null
$xml = Get-Content "$env:TEMP\xiaoan-ui.xml" -Raw -ErrorAction SilentlyContinue

$edit = [regex]::Match($xml, 'class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
if (-not $edit.Success) {
    Write-Host "NO_LOCK_SCREEN (already unlocked?)"
    exit 0
}
$ex = [int](([int]$edit.Groups[1].Value + [int]$edit.Groups[3].Value) / 2)
$ey = [int](([int]$edit.Groups[2].Value + [int]$edit.Groups[4].Value) / 2)

$btn = [regex]::Match($xml, 'class="android.widget.Button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
if (-not $btn.Success) {
    Write-Host "NO_ENTER_BUTTON"
    exit 1
}
$bx = [int](([int]$btn.Groups[1].Value + [int]$btn.Groups[3].Value) / 2)
$by = [int](([int]$btn.Groups[2].Value + [int]$btn.Groups[4].Value) / 2)

# 3. tap password field, type password, close keyboard, re-dump, tap enter
& $adb shell input tap $ex $ey 2>$null
Start-Sleep -Milliseconds 900
# single quotes protect the star from the device shell glob
& $adb shell "input text '<YOUR_APP_PASSWORD>'" 2>$null
Start-Sleep -Milliseconds 700
& $adb shell input keyevent 111 2>$null   # ESC: close soft keyboard (button moves back)
Start-Sleep -Milliseconds 900
# re-dump for the button's CURRENT position (keyboard open/closed shifts it)
& $adb shell uiautomator dump /sdcard/ui1b.xml 2>$null | Out-Null
& $adb pull /sdcard/ui1b.xml "$env:TEMP\xiaoan-ui1b.xml" 2>$null | Out-Null
$xmlB = Get-Content "$env:TEMP\xiaoan-ui1b.xml" -Raw -ErrorAction SilentlyContinue
$btnB = [regex]::Match($xmlB, 'class="android.widget.Button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
if ($btnB.Success) {
    $bx = [int](([int]$btnB.Groups[1].Value + [int]$btnB.Groups[3].Value) / 2)
    $by = [int](([int]$btnB.Groups[2].Value + [int]$btnB.Groups[4].Value) / 2)
}
& $adb shell input tap $bx $by 2>$null
Start-Sleep -Seconds 3

# 4. verify unlock (lock screen gone = success)
& $adb shell uiautomator dump /sdcard/ui2.xml 2>$null | Out-Null
& $adb pull /sdcard/ui2.xml "$env:TEMP\xiaoan-ui2.xml" 2>$null | Out-Null
$xml2 = Get-Content "$env:TEMP\xiaoan-ui2.xml" -Raw -ErrorAction SilentlyContinue
if ($xml2 -match 'class="android.widget.EditText"') {
    Write-Host "STILL_LOCKED (password input failed?)"
    exit 1
} else {
    Write-Host ("UNLOCKED_OK (pw " + $ex + "," + $ey + " -> btn " + $bx + "," + $by + ")")
}
