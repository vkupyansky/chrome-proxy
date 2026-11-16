[English](README.md) · [Русский](README.ru.md)

# Chrome Proxy

A small Chrome extension for routing one browser profile through a proxy, with direct connections for selected sites. The interface is in Russian and designed for macOS.

The popup contains quick controls for the connection mode and current site. A separate settings page shows the proxy address, automatic rules and a searchable list of site exceptions.

## Install

Requires Chrome 123 or later.

1. [Download the project ZIP](https://github.com/vkupyansky/chrome-proxy/archive/refs/heads/main.zip) and extract it to a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Open the extension. A new installation starts in **Как в macOS** (system settings). Select **Авто** to enable its routing rules.

The compiled `dist/` files are included. Node.js, npm and a build are not needed to use the extension.

By default, the extension expects an existing HTTP proxy at `127.0.0.1:10809`, such as Happ in Proxy mode. Change the address in **Настройки** if needed. The extension does not start a proxy server or tunnel.

## Connection modes

- **Авто** (auto): local addresses, .ru/.su/.рф domains and saved exceptions connect directly; other sites use the configured proxy. Direct fallback is enabled by default when the proxy is unavailable.
- **Напрямую** (direct): every site in this profile uses an ordinary connection without a proxy. Saved rules remain available.
- **Как в macOS** (system): releases the extension's control and uses system settings or another controlling extension. This mode can still use a proxy.

Click **Открывать напрямую** in the popup to add the current site's domain. Exceptions cover the domain and its subdomains. The settings page accepts a domain or website URL, supports search and removal, and asks for confirmation before clearing the whole list. Rules can be edited in any mode; they take effect in auto mode.

The settings page also exposes these controls:

- HTTP or SOCKS5 proxy address and port, without authentication.
- Direct access to the local network.
- Direct access to .ru, .su and .рф domains.
- Permission to try a direct connection if the proxy is unavailable.

Local rules cover simple hostnames, .local/.localhost/.home.arpa, private IPv4, loopback, link-local and IPv6 ULA addresses. IP rules inspect literal addresses in URLs; they do not resolve domains through DNS.

## Update

Replace the extension files in the **same folder**, then click its reload button on `chrome://extensions`. Do not uninstall the extension for a normal update. The previous enabled mode and site exceptions migrate automatically; invalid saved data is reported instead of silently reset.

Moving the folder may change the extension ID and its storage. Chrome itself does not need a restart.

## Privacy and limits

The extension applies to the profile where it is installed. It does not change macOS network settings, other profiles, Happ or other applications. There are no runtime dependencies, analytics, remote code or external fonts.

Permissions are limited to `proxy` for this profile's routing, `storage` for local settings and `activeTab` to read the current site's domain after clicking the extension. Proxy credentials are not supported or required.

Russian domain suffixes do not identify a site's owner or server location; add other sites manually. Direct fallback handles an unavailable proxy connection; an HTTP error returned by the proxy does not always trigger it. Chrome can continue using a direct connection for a few minutes after the proxy recovers because of its bad-proxy cache.

The interface reports the applied routing rule and Chrome's control status, not a live measurement of every request's route.

## Development

Use Node.js **24.18.0**, pinned in [`.node-version`](.node-version).

```sh
npm ci --ignore-scripts
npm run check
```

The single check command runs Biome with warnings treated as errors, strict TypeScript compilation, manifest checks, routing/controller regressions and UI scenarios in an isolated Chrome profile. Google Chrome is required for browser tests; set `CHROME_BIN` if its executable is elsewhere.

```sh
npm run format
npm run build
```

`src/` contains the TypeScript source; `dist/` contains the generated JavaScript loaded by Chrome. Commit regenerated `dist/` files with source changes. Settings and messages are validated at their boundaries, changes are serialized, and Chrome's applied configuration is checked before saving. Failed changes restore the previous configuration and report an error.

Development dependencies are TypeScript, Chrome API types and Biome. `node_modules/` is only needed to build and check the project; it can be removed afterward without affecting the installed extension.
