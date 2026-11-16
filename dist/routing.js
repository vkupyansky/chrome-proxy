export function getHostname(value) {
    if (typeof value !== "string")
        return "";
    const raw = value.trim().toLowerCase();
    if (!raw)
        return "";
    try {
        const address = !raw.includes("://") && !raw.startsWith("[") && raw.split(":").length > 2 ? `[${raw}]` : raw;
        const url = new URL(address.includes("://") ? address : `https://${address}`);
        if (!["http:", "https:"].includes(url.protocol))
            return "";
        return url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
    }
    catch {
        return "";
    }
}
export function normalizeHost(value) {
    const host = getHostname(value).replace(/^www\./, "");
    return host.length <= 253 &&
        host.includes(".") &&
        host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) &&
        !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)
        ? host
        : "";
}
export function normalizeSites(value) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map(normalizeHost).filter(Boolean))].sort();
}
// Serialized into PAC: keep this function independent of imports and browser APIs.
export function classifyHost(value, siteRules, bypassLocal = true, bypassRussian = true) {
    const host = value
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.+$/g, "");
    const route = (kind, rule = "") => ({
        direct: kind !== "proxy",
        kind,
        rule,
    });
    const matches = (domain) => host === domain || host.endsWith(`.${domain}`);
    const localIpv4 = (parts) => parts[0] === 10 ||
        parts[0] === 127 ||
        (parts[0] === 172 && (parts[1] ?? -1) >= 16 && (parts[1] ?? 256) <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 169 && parts[1] === 254) ||
        parts.every((part) => part === 0);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        const parts = host.split(".").map(Number);
        return route(bypassLocal && parts.every((part) => part <= 255) && localIpv4(parts) ? "local" : "proxy");
    }
    if (host.includes(":")) {
        const mapped = host.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
        const high = mapped?.[1] ? parseInt(mapped[1], 16) : 0;
        const low = mapped?.[2] ? parseInt(mapped[2], 16) : 0;
        const local = host === "::1" ||
            host === "::" ||
            /^f[cd][a-f0-9]{2}:/.test(host) ||
            /^fe[89ab][a-f0-9]:/.test(host) ||
            (mapped !== null && localIpv4([high >> 8, high & 255, low >> 8, low & 255]));
        return route(bypassLocal && local ? "local" : "proxy");
    }
    if (!host)
        return route("proxy");
    if (bypassLocal && (!host.includes(".") || ["localhost", "local", "home.arpa"].some(matches))) {
        return route("local");
    }
    const suffix = bypassRussian ? ["ru", "su", "xn--p1ai"].find(matches) : undefined;
    if (suffix)
        return route("russian", `.${suffix}`);
    const site = siteRules.find(matches);
    return site ? route("site", site) : route("proxy");
}
export function getPacScript(settings) {
    const { proxy } = settings;
    const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
    const directive = `${proxy.scheme === "socks5" ? "SOCKS5" : "PROXY"} ${host}:${proxy.port}${settings.fallbackDirect ? "; DIRECT" : ""}`;
    return `const classifyHost = ${classifyHost.toString()};\nfunction FindProxyForURL(url, host) {\n  return classifyHost(host, ${JSON.stringify(settings.siteRules)}, ${settings.bypassLocal}, ${settings.bypassRussian}).direct ? "DIRECT" : ${JSON.stringify(directive)};\n}`;
}
