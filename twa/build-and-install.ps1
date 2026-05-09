# TWA: build and install on phone
# Needs: Node 18+, Java 17+, Android SDK, twa/keystore/wordle.jks
# If twa/app/ missing: run bubblewrap init first (see README)

$ErrorActionPreference = "Stop"
$twaDir = $PSScriptRoot
Set-Location $twaDir

if (-not (Test-Path "app")) {
    Write-Host "No Android project (twa/app/). Run first:" -ForegroundColor Yellow
    Write-Host "  npx @bubblewrap/cli init --manifest=https://bugats-wordle-server.onrender.com/manifest.json" -ForegroundColor Cyan
    Write-Host "Then run this script again." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path "keystore\wordle.jks")) {
    Write-Host "Missing keystore: twa/keystore/wordle.jks" -ForegroundColor Red
    Write-Host "Create: keytool -genkey -v -keystore wordle.jks -keyalg RSA -keysize 2048 -validity 10000 -alias varduzona" -ForegroundColor Cyan
    exit 1
}

Write-Host "Updating project from twa-manifest.json..." -ForegroundColor Green
npx --yes @bubblewrap/cli update

Write-Host "Building APK..." -ForegroundColor Green
npx --yes @bubblewrap/cli build

$apk = Get-ChildItem -Path $twaDir -Filter "app-release-signed.apk" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($apk) {
    Write-Host "APK: $($apk.FullName)" -ForegroundColor Green
    $adb = Get-Command adb -ErrorAction SilentlyContinue
    if ($adb) {
        $devices = adb devices 2>$null
        if ($devices -match "device$") {
            Write-Host "Installing on device..." -ForegroundColor Green
            adb install -r $apk.FullName
        } else {
            Write-Host "Phone not connected (adb). Copy APK to device and open." -ForegroundColor Yellow
        }
    } else {
        Write-Host "adb not found. Copy APK to phone and open." -ForegroundColor Yellow
    }
} else {
    Write-Host "APK not found after build." -ForegroundColor Red
    exit 1
}
