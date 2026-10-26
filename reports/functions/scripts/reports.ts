// The maintainer's review of reports, run from the repo root:
//   npm run reports -- list [--accepted]         pending (or accepted) reports, by procedure
//   npm run reports -- show <id>                 one report, with its contact if any
//   npm run reports -- find <email>              the reports someone who left this email sent
//   npm run reports -- accept <id> [--tip "…"] [--rejection-reason "…"] [--extra-document "…"]
//                                                 (again, to change them; "" removes one)
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
import { accept, describe, exportAccepted, exportPath, findByEmail, list, reject, remove, show } from "./review";

const USAGE =
  'commands: list [--accepted], show <id>, find <email>, accept <id> [--tip "…"] [--rejection-reason "…"] [--extra-document "…"], reject <id>, delete <id>, export [file]; with --project <id> or GCLOUD_PROJECT';
const ROOT = path.resolve(__dirname, "..", "..", "..");

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        project: { type: "string" },
        accepted: { type: "boolean" },
        tip: { type: "string" },
        "rejection-reason": { type: "string" },
        "extra-document": { type: "string" },
      },
    });
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command, arg] = positionals;
  const projectId = values.project ?? process.env.GCLOUD_PROJECT;
  if (!projectId) throw new Error("say which Firebase project: --project <id> or GCLOUD_PROJECT");
  const db = getFirestore(initializeApp({ projectId }));
  // Said every time, so a stray FIRESTORE_EMULATOR_HOST or GCLOUD_PROJECT shows.
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  console.error(emulator ? `(emulator at ${emulator}, project ${projectId})` : `(project ${projectId})`);
  const need = (what = "a report id") => {
    if (!arg) throw new Error(`${command} needs ${what}`);
    return arg;
  };

  switch (command) {
    case "list": {
      const status = values.accepted ? "accepted" : "pending";
      const reports = await list(db, status);
      let last = "";
      for (const r of reports) {
        if (r.procedure !== last) console.log(`\n${(last = String(r.procedure))}`);
        console.log(describe(r));
      }
      console.log(`\n${reports.length} ${status}`);
      return;
    }
    case "show": {
      const { report, contact } = await show(db, need());
      console.log(JSON.stringify(report, null, 2));
      if (contact) console.log(`contatto: ${contact}`);
      return;
    }
    case "find": {
      const ids = await findByEmail(db, need("an email address"));
      console.log(ids.length ? ids.join("\n") : "no reports with that email (it is deleted 12 months after the report)");
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
      const file = exportPath(arg, process.env.INIT_CWD ?? process.cwd(), ROOT);
      const reports = await exportAccepted(db);
      writeFileSync(file, JSON.stringify(reports, null, 2) + "\n");
      console.log(`wrote ${reports.length} accepted reports to ${file}; now run npm run reports:aggregate`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
