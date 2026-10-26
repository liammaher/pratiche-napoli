// Copies what the function shares with the library into src/shared, so there is
// one implementation of the personal-data check and one report schema. Firebase
// deploys only this folder, so it can't import them from the repo directly.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const out = path.resolve(here, "..", "src", "shared");
mkdirSync(out, { recursive: true });

const personal = readFileSync(path.join(repo, "tools", "lib", "personal.ts"), "utf8");
writeFileSync(path.join(out, "personal.ts"), `// Copied from tools/lib/personal.ts: edit that file, not this one.\n\n${personal}`);
copyFileSync(path.join(repo, "contract", "report.schema.json"), path.join(out, "report.schema.json"));
