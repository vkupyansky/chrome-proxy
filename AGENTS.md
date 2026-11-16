# Development

- Manifest V3 with a module service worker. TypeScript source is in `src/`; Chrome loads the generated JavaScript in `dist/`. Rebuild after source changes and commit the generated files. Do not edit `dist/` by hand.
- `settings.ts` validates settings/messages and migrates old `enabled`/`siteRules` values to the canonical `settings` key. Preserve existing modes and exceptions. A new installation uses system mode; invalid stored data must not silently reset.
- `routing.ts` owns matching and PAC generation. The serialized `classifyHost` function must be self-contained, without imports, URL/browser APIs or DNS. Domain rules include subdomains; IP ranges apply only to literal addresses.
- `controller.ts` serializes mutations, checks Chrome's applied configuration, then saves settings. Failed changes restore the previous configuration. Use partial settings patches and separate exception commands to preserve concurrent edits.
- `background.ts` connects the controller to Chrome. `client.ts`, `popup.ts` and `options.ts` implement the UI. Keep quick actions in the popup and the complete settings/list on `options.html`.
- `auto` applies the configured proxy and bypass rules, with optional direct fallback. `direct` forces a direct connection for the profile. `system` releases extension control; do not describe it as direct access.
- Do not start proxy servers, change system networking or modify other profiles/applications. Permissions stay limited to `activeTab`, `proxy` and `storage`. Do not add credentials or browsing-history access.
- Use Node.js `24.18.0`, `npm ci --ignore-scripts` and `npm run check`. Strict TypeScript, Biome and warnings-as-errors are required. Browser tests use their own temporary profiles; never change a real browser profile or interrupt its working proxy for a test.
- Keep [README.md](README.md) and [README.ru.md](README.ru.md) aligned. Installation uses the included `dist/` files without a developer toolchain.
