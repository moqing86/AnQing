# Security Policy

## The important part: this is a personal companion app

AnQing stores conversations, memories and persona files **locally on the device**. Treat a phone running
this app as a device holding private data.

## Reporting a vulnerability

Open a **private security advisory** on GitHub (Security → Report a vulnerability), or contact the maintainer
through GitHub. Please do not open a public issue for anything that could expose user data.

## Known design points (not vulnerabilities)

| Item | Note |
|---|---|
| **Default password `anqing2026`** | Ships intentionally so a fresh clone can boot. **Change it before use** — see README. |
| **Local HTTP server on `127.0.0.1:3083`** | Bound to loopback; the WebView talks to it. Not exposed to the LAN. |
| **`config.json` holds your model API key** | It lives on the device and is git-ignored. The repo only ships `config.example.json`. |
| **Dev endpoints (`/api/dev-*`)** | Left in for development convenience; they are only reachable from the device itself. Feel free to strip them in a production fork. |

## Please do not

- Include real chat logs, memory files, avatars or voice samples in issues / PRs / screenshots.
- Publish API keys, tokens or your app password.
- Use the voice-cloning feature with reference audio you do not have the rights to use, or distribute
  models/voices derived from other people's work.

## Scope

The maintainer can only support builds on `arm64-v8a` Android, tested mostly on ColorOS. Reports from other
devices are welcome but may not be reproducible.
