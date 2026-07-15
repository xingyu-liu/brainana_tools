import { spawnSync } from "node:child_process";
const steps = [
  ["version", ["node", "scripts/check-version.mjs"]],
  ["documentation", ["node", "scripts/check-docs.mjs"]],
  ["typecheck/build", ["npm", "run", "build"]],
  ["lint", ["npm", "run", "lint"]],
  ["format", ["npm", "run", "format:check"]],
  ["tests", ["npm", "test"]],
  ["scientific transforms", ["npm", "run", "test:transforms"]],
  ["browser smoke", ["npm", "run", "test:browser"]],
  ["release structure", ["npm", "run", "package:check"]],
];
for (const [name, [cmd, ...args]] of steps) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log("\nValidation gate passed");
