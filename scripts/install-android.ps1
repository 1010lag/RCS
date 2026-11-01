param(
    [string]$Serial,
    [string]$Apk = '.data\apk\RCS.apk',
    [switch]$Build,
    [switch]$VerifyUI
)
$ErrorActionPreference = 'Stop'
if ($VerifyUI) { throw 'Release APKs disable the WebView debugger. Run browser UI checks with npm run test:e2e; use this script without -VerifyUI to install and capture a release APK.' }
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$sdkDirectory = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE '.codex\.tmp\rcs-android-sdk' }
$adbExecutable = Join-Path $sdkDirectory 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adbExecutable)) { throw 'Android platform-tools are required' }
if ($Build) {
    & "$PSScriptRoot\build-android.ps1"
}
if (-not (Test-Path -LiteralPath $Apk)) { throw 'APK not found. Build it first with npm run android:build.' }
$apkFile = (Resolve-Path -LiteralPath $Apk).Path
$connected = @(& $adbExecutable devices | Select-String '^([^\s]+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
if (-not $Serial) {
    if ($connected.Count -ne 1) { throw 'Connect exactly one authorized phone, or provide -Serial.' }
    $Serial = $connected[0]
}
if ($Serial -notin $connected) { throw 'This phone is not connected and authorized. Check adb devices.' }
& $adbExecutable -s $Serial install -r $apkFile
if ($LASTEXITCODE -ne 0) { throw 'Installation failed. Check the phone for a confirmation prompt.' }
& $adbExecutable -s $Serial shell am start -W -n 'by.rcs.app/.MainActivity'
if ($LASTEXITCODE -ne 0) { throw 'RCS could not be started.' }
Start-Sleep -Seconds 2
$appPid = ([string](& $adbExecutable -s $Serial shell pidof by.rcs.app)).Trim()
if (-not $appPid) { throw 'RCS is not running after launch.' }
$foreground = & $adbExecutable -s $Serial shell dumpsys activity activities | Select-String 'mResumedActivity|topResumedActivity'
if (($foreground | Out-String) -notmatch 'by\.rcs\.app/') { throw 'RCS is not in the foreground. Unlock the phone and open RCS before capturing it.' }
$artifactDirectory = Join-Path (Get-Location) '.data\qa\phone'
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$screenshot = Join-Path $artifactDirectory "rcs-$stamp.png"
& $adbExecutable -s $Serial shell screencap -p /data/local/tmp/rcs-verification.png
if ($LASTEXITCODE -ne 0) { throw 'Could not capture the screen.' }
& $adbExecutable -s $Serial pull /data/local/tmp/rcs-verification.png $screenshot
if ($LASTEXITCODE -ne 0) { throw 'Could not save the screenshot.' }
& $adbExecutable -s $Serial shell rm -f /data/local/tmp/rcs-verification.png
& $adbExecutable -s $Serial logcat -d -t 2000 "--pid=$appPid" | Set-Content -LiteralPath (Join-Path $artifactDirectory "rcs-$stamp.log") -Encoding UTF8
if ($VerifyUI) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else {
        $nodeDirectory = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.codex\.tmp') -Directory -Filter 'node-*-win-x64' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $nodeDirectory) { throw 'Node.js is required for phone UI checks.' }
        Join-Path $nodeDirectory.FullName 'node.exe'
    }
    & $adbExecutable -s $Serial forward tcp:9223 "localabstract:webview_devtools_remote_$appPid"
    if ($LASTEXITCODE -ne 0) { throw 'Could not connect the RCS WebView debugger.' }
    try {
        & $nodeExecutable scripts/verify-android.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Phone UI checks failed. See the reported check above.' }
    } finally {
        & $adbExecutable -s $Serial forward --remove tcp:9223
    }
}
Write-Output "RCS installed over the existing app and started. Screenshot: $screenshot"
