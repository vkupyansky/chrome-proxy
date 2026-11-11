[![Русский](https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-181717?style=for-the-badge)](README.ru.md)

# Chrome Proxy

A Chrome Manifest V3 extension for proxy routing and per-site exclusions. It applies only to the Chrome profile where it is installed and does not change system settings or other applications.

## Features

- A global proxy switch with settings preserved between sessions.
- Exclusions for the current site or a manually entered domain and its subdomains.
- Edit exclusions while paused without enabling the proxy.
- Retry a failed disable operation while retaining the previous switch position.

## Installation and startup

1. Start your SOCKS5 server. The default is the local endpoint `127.0.0.1:21982`; configure it in `PROXY_CONFIG` in `background.js`.
2. Open `chrome://extensions` and enable Developer mode.
3. Click "Load unpacked" and select the project folder.
4. Open Chrome Proxy using its extension icon. A new installation starts paused; use the switch to enable the proxy.

The extension does not include a server or tunnel. SOCKS5 is used without a username or password; do not add credentials to the source files. After changing files, reload the extension at `chrome://extensions`.

## Usage

- `ALL`: all public sites use the proxy.
- `EX`: saved domains and their subdomains connect directly; other sites use the proxy.
- Paused: the extension removes its proxy settings without deleting exclusions.

The "Исключить" (Exclude) button adds the current domain. You can also enter a domain manually, remove an individual exclusion, or clear the list. If disabling fails, the switch retains its previous position so you can retry.

## Checks

Node.js 24 LTS is required; the exact version is specified in [.node-version](.node-version). There are no external dependencies or build step.

```bash
node scripts/check.mjs
```

This command checks syntax, the manifest, PAC, settings persistence, concurrency, and Chrome API errors. Checks are isolated from the user profile and do not alter external traffic. Warnings are treated as errors.

## Limitations

Local names and private IPv4 addresses always connect directly. For other sites, there is no direct connection fallback if SOCKS5 is unavailable. The icon indicates whether Chrome settings were applied; the owner must check server availability and the external IP separately.

Keep the unpacked extension folder in a permanent location. Moving it may change the extension ID, and saved exclusions are not transferred automatically.
