param([string]$ApiUrl = 'https://rcs-team-1010lag.onrender.com')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$toolsRoot = Join-Path $env:USERPROFILE '.codex\.tmp'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeDir = Get-ChildItem -LiteralPath $toolsRoot -Directory -Filter 'node-*-win-x64' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $nodeDir) { throw 'Node.js is required' }
    $env:Path = $nodeDir.FullName + ';' + $env:Path
}
if (-not $env:JAVA_HOME) {
    $jdkDir = Get-ChildItem -LiteralPath $toolsRoot -Directory -Filter 'jdk-21*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $jdkDir) { throw 'JDK 21 is required' }
    $env:JAVA_HOME = $jdkDir.FullName
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $toolsRoot 'rcs-android-sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'platforms\android-36\android.jar'))) { throw 'Android SDK 36 is required' }
$env:GRADLE_USER_HOME = Join-Path $toolsRoot 'rcs-gradle'
$env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
$env:VITE_API_URL = $ApiUrl
$env:VITE_NATIVE_FIREBASE_CONFIGURED = (Test-Path -LiteralPath 'android\app\google-services.json').ToString().ToLowerInvariant()
if ($env:VITE_NATIVE_FIREBASE_CONFIGURED -eq 'true') {
    $firebaseAndroid = Get-Content -LiteralPath 'android\app\google-services.json' -Raw | ConvertFrom-Json
    if (-not $firebaseAndroid.project_info.project_id -or -not ($firebaseAndroid.client | Where-Object { $_.client_info.android_client_info.package_name -eq 'by.rcs.app' })) { throw 'google-services.json must register by.rcs.app in a Firebase project' }
    $env:VITE_NATIVE_FIREBASE_PROJECT_ID = $firebaseAndroid.project_info.project_id
} else { Remove-Item Env:VITE_NATIVE_FIREBASE_PROJECT_ID -ErrorAction SilentlyContinue }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
& npx.cmd cap sync android
if ($LASTEXITCODE -ne 0) { throw 'Android sync failed' }
Push-Location -LiteralPath android
try {
    & .\gradlew.bat --no-daemon --max-workers=2 :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
} finally { Pop-Location }
New-Item -ItemType Directory -Path '.data\apk' -Force | Out-Null
Copy-Item -LiteralPath 'android\app\build\outputs\apk\debug\app-debug.apk' -Destination '.data\apk\RCS.apk' -Force
Get-Item -LiteralPath '.data\apk\RCS.apk' | Select-Object FullName,Length
Get-FileHash -LiteralPath '.data\apk\RCS.apk' -Algorithm SHA256
