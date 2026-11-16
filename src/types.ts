export type Mode = "auto" | "direct" | "system";
export type ProxyScheme = "http" | "socks5";

export interface Settings {
  schemaVersion: 1;
  mode: Mode;
  proxy: { scheme: ProxyScheme; host: string; port: number };
  fallbackDirect: boolean;
  bypassLocal: boolean;
  bypassRussian: boolean;
  siteRules: string[];
}

export interface Route {
  kind: "proxy" | "local" | "russian" | "site";
  direct: boolean;
  rule: string;
}

export interface PublicState {
  settings: Settings;
  control: string;
  error: string;
  notice: string;
}

export type SettingsPatch = Partial<Omit<Settings, "schemaVersion" | "siteRules">>;
export type Message =
  | { type: "GET_STATE" }
  | { type: "UPDATE_SETTINGS"; patch: SettingsPatch }
  | { type: "ADD_SITE" | "REMOVE_SITE"; host: string }
  | { type: "CLEAR_SITES" }
  | { type: "REAPPLY" };

export type Response =
  | { ok: true; state: PublicState }
  | { ok: false; error: string; state?: PublicState };
