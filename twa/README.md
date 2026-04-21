# TWA wrapper (Android / Play Store)

This folder contains a minimal TWA (Trusted Web Activity) template for the Wordle web app.
It uses Bubblewrap to generate an Android project that always loads the live web version.

## Prereqs
- Node.js 18+
- Android Studio (for Android SDK)
- Java 17+
- A custom domain that serves the app over HTTPS (recommended: https://wordle.thezone.lv/)

## Steps (recommended flow)
1) Install Bubblewrap:
   npm install -g @bubblewrap/cli

2) Generate a signing key (keystore) in `twa/keystore/`:
   keytool -genkey -v -keystore wordle.jks -keyalg RSA -keysize 2048 -validity 10000 -alias varduzona

3) Get SHA256 cert fingerprint (needed for assetlinks.json):
   keytool -list -v -keystore keystore/wordle.jks -alias varduzona | findstr SHA256

4) Update /public/.well-known/assetlinks.json:
   - package_name: lv.thezone.wordle
   - sha256_cert_fingerprints: replace with your SHA256

5) Update `twa-manifest.json` in this folder if needed (`packageId`, `host`, `name`, `iconUrl`).
   - `packageId` must match the Play Console app package exactly.
   - For VĀRDU ZONA, use `lv.thezone.wordle` consistently in both Play Console and `assetlinks.json`.
   - Host is set to bugats-wordle-server.onrender.com.

6) Init the TWA project (only first time; creates twa/app/):
   bubblewrap init --manifest=https://bugats-wordle-server.onrender.com/manifest.json

7) Build and optionally install on connected phone:
   .\build-and-install.ps1
   Or manually: `bubblewrap update` then `bubblewrap build`. APK: twa/app/build/outputs/apk/release/app-release-signed.apk

8) Upload the AAB to Google Play Console (from build output).

## Notes
- The app will always show the live web version, so updates are instant.
- Replace the iconUrl with a 512x512 PNG for the Play Store if needed.
