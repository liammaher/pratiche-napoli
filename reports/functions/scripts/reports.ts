// The maintainer's review of reports, run from the repo root:
//   npm run reports -- list                      pending reports, by procedure
//   npm run reports -- show <id>                 one report, with its contact if any
//   npm run reports -- accept <id> [--tip "…"] [--rejection-reason "…"] [--extra-document "…"]
//   npm run reports -- reject <id>
//   npm run reports -- delete <id>               on request: the report and its contact
//   npm run reports -- export [file]             accepted reports for reports:aggregate
// The project comes from --project or GCLOUD_PROJECT; credentials from
// `gcloud auth application-default login` (as your personal account). With
// FIRESTORE_EMULATOR_HOST set it talks to the emulator instead.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { accept, describe, exportAccepted, pending, reject, remove, show } from "./review";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    tip: { type: "string" },
    "rejection-reason": { type: "string" },
    "extra-document": { type: "string" },
  },
});
const [command, arg] = positionals;
const projectId = values.project ?? process.env.GCLOUD_PROJECT;
if (!projectId) {
  console.error("say which Firebase project: --project <id> or GCLOUD_PROJECT");
  process.exit(2);
}
const db = getFirestore(initializeApp({ projectId }));
const ROOT = path.resolve(__dirname, "..", "..", "..");

const need = () => {
  if (!arg) throw new Error(`${command} needs a report id`);
  return arg;
};

async function main(): Promise<void> {
  switch (command) {
    case "list": {
      const reports = await pending(db);
      let last = "";
      for (const r of reports) {
        if (r.procedure !== last) console.log(`\n${(last = String(r.procedure))}`);
        console.log(describe(r));
      }
      console.log(`\n${reports.length} pending`);
      return;
    }
    case "show": {
      const { report, contact } = await show(db, need());
      console.log(JSON.stringify(report, null, 2));
      if (contact) console.log(`contatto: ${contact}`);
      return;
    }
    case "accept":
      await accept(db, need(), {
        tip: values.tip,
        rejection_reason: values["rejection-reason"],
        extra_document: values["extra-document"],
      });
      console.log(`accepted ${arg}`);
      return;
    case "reject":
      await reject(db, need());
      console.log(`rejected ${arg}`);
      return;
    case "delete":
      await remove(db, need());
      console.log(`deleted ${arg} and its contact`);
      return;
    case "export": {
      const file = path.resolve(arg ?? path.join(ROOT, "reports-cache.json"));
      const reports = await exportAccepted(db);
      writeFileSync(file, JSON.stringify(reports, null, 2) + "\n");
      console.log(`wrote ${reports.length} accepted reports to ${file}; now run npm run reports:aggregate`);
      return;
    }
    default:
      throw new Error("commands: list, show <id>, accept <id>, reject <id>, delete <id>, export [file]");
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
