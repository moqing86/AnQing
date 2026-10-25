# Contributing to AnQing

Thanks for your interest! This is a personal project that is still actively developed, and contributions are welcome.

## Before you start

- **Read the README first** — especially the *default password* section. The default password (`anqing2026`) is public; change it before flashing anything to a real device.
- **Privacy rule**: never include real chat logs, memory files, persona files, voice samples, avatars or API keys in a PR. The repo must stay free of user data.
- **Model weights and APKs are not accepted** — they are large and may carry license constraints. Keep them out of git.

## What kinds of changes fit

| Area | Notes |
|---|---|
| Bug fixes | Very welcome. Please describe how to reproduce. |
| On-device performance | TTS/ASR latency, memory, battery — measured numbers are valued over guesses. |
| UI/UX polish | The UI aims to feel like a real chat app, not a dashboard. |
| Docs & translations | Fixes to the English wording are especially helpful. |
| New features | Open an issue first so we can agree on scope. |

## How to build and test

```bash
cp config.example.json config.json   # fill in your own model key
powershell -File scripts/prepare-app-assets.ps1
powershell -File scripts/build-apk.ps1
```

There is no Gradle project: the APK is assembled by the scripts in `scripts/`
(`aapt2 → javac → d8 → aapt add → zipalign → apksigner`).

## Pull requests

1. Keep changes focused — one topic per PR.
2. Describe **what you measured**, not just what you changed (for anything performance-related).
3. If you touched the Node engine (`server.js`) or the UI (`web/index.html`), say how you verified it
   (on a device? which Android version?).
4. By submitting a PR you agree your contribution is licensed under the project's MIT license.

## Reporting issues

Please include:

- Device + Android version (this project was only tested on arm64 / ColorOS so far)
- What you expected vs. what happened
- Logs if you have them (`adb logcat | grep -i xiaoan`)
- **Do not paste personal chat content** — redact it.
