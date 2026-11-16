import "../tests/strict.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (
  process.env.NODE_NO_WARNINGS !== undefined ||
  /--no-(?:warnings|deprecation)/u.test(process.env.NODE_OPTIONS ?? "")
) {
  throw new Error("Подавление предупреждений запрещено");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(resolve(root, "node_modules/.bin/biome"), ["check", "--error-on-warnings", "."]);
run(resolve(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, "module");
assert.deepEqual(manifest.permissions, ["activeTab", "proxy", "storage"]);
for (const file of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons),
]) {
  await readFile(resolve(root, file));
}
run(process.execPath, [
  "--import",
  "./tests/strict.mjs",
  "--test",
  "tests/extension.test.js",
  "tests/ui.test.mjs",
]);
