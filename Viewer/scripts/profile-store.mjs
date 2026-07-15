import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [command, jsonPath, legacyPath, ...args] = process.argv.slice(2);
if (!command || !jsonPath)
  throw new Error(
    "Usage: profile-store <command> <json-path> [legacy-tsv-path] [...args]",
  );
const defaults = [
  {
    id: crypto.randomUUID(),
    name: "Penn workstation",
    username: "ekim",
    host: "128.91.12.238",
    root: "/mnt/DataDrive3/swap/test_brainana/preproc/frosty/preprocessed",
    port: 5273,
  },
  {
    id: crypto.randomUUID(),
    name: "Bigbox",
    username: "msl1",
    host: "bigbox.med.harvard.edu",
    root: "/data/brainana/output",
    port: 5273,
  },
];
const clean = (value) =>
  String(value ?? "")
    .replace(/[\0\r\n]/g, " ")
    .trim();
const normalize = (p) => ({
  id: clean(p.id) || crypto.randomUUID(),
  name: clean(p.name),
  username: clean(p.username),
  host: clean(p.host),
  root: clean(p.root),
  port: Number.isInteger(Number(p.port)) ? Number(p.port) : 5273,
});
function atomicWrite(data) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const temp = `${jsonPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, jsonPath);
  fs.chmodSync(jsonPath, 0o600);
}
function readLegacy() {
  if (!legacyPath || !fs.existsSync(legacyPath)) return [];
  return fs
    .readFileSync(legacyPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const [name, username, host, root, port] = line.split("\t");
      return name && username && host && root
        ? [normalize({ name, username, host, root, port })]
        : [];
    });
}
function load() {
  if (fs.existsSync(jsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.profiles))
      throw new Error("Unsupported profiles schema");
    return { schemaVersion: 1, profiles: parsed.profiles.map(normalize) };
  }
  const migrated = readLegacy();
  const data = {
    schemaVersion: 1,
    profiles: migrated.length ? migrated : defaults,
  };
  atomicWrite(data);
  if (migrated.length && legacyPath)
    fs.renameSync(legacyPath, `${legacyPath}.migrated`);
  return data;
}
const shellQuote = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;
const data = load();
if (command === "init") process.exit(0);
if (command === "list") {
  for (const p of data.profiles) console.log(p.name);
  process.exit(0);
}
if (command === "get-shell") {
  const p = data.profiles.find((x) => x.name === args[0]);
  if (!p) process.exit(2);
  for (const [key, value] of [
    ["PROFILE_ID", p.id],
    ["PROFILE_NAME", p.name],
    ["USERNAME", p.username],
    ["HOST", p.host],
    ["OUTPUT_DIR", p.root],
    ["PROFILE_PORT", p.port],
  ])
    console.log(`${key}=${shellQuote(value)}`);
  process.exit(0);
}
if (command === "upsert") {
  const [oldName, name, username, host, root, port] = args;
  const existing = data.profiles.find(
    (p) => p.name === oldName || p.name === name,
  );
  const profile = normalize({
    id: existing?.id,
    name,
    username,
    host,
    root,
    port,
  });
  if (!profile.name || !profile.username || !profile.host || !profile.root)
    throw new Error("Missing required profile field");
  data.profiles = data.profiles.filter(
    (p) => p.id !== profile.id && p.name !== oldName && p.name !== profile.name,
  );
  data.profiles.push(profile);
  atomicWrite(data);
  process.exit(0);
}
if (command === "delete") {
  data.profiles = data.profiles.filter((p) => p.name !== args[0]);
  atomicWrite(data);
  process.exit(0);
}
throw new Error(`Unknown command: ${command}`);
