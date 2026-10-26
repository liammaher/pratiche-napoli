// The reports backend: one HTTPS function, in Milan, that the site's form and
// assistants post reports to.

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { createHandler, type Handler } from "./handler";
import { procedureIndex } from "./procedures";

initializeApp();

const SITE_URL = defineString("SITE_URL", {
  description: "The site's address, without a trailing slash: its procedures.json lists the procedures, and form posts return to its /grazie/ page",
  default: "https://liammaher.github.io/pratiche-napoli",
});
// Salts the IP hash used for rate limiting, so the hashes can't be reversed by
// trying every address.
const RATE_LIMIT_SALT = defineSecret("RATE_LIMIT_SALT");

let handler: Handler | undefined;

export const submitReport = onRequest(
  {
    region: "europe-west8",
    memory: "256MiB",
    timeoutSeconds: 10,
    maxInstances: 3,
    invoker: "public",
    secrets: [RATE_LIMIT_SALT],
  },
  (req, res) => {
    if (!handler) {
      const siteUrl = SITE_URL.value().replace(/\/+$/, "");
      const salt = RATE_LIMIT_SALT.value();
      if (!salt) throw new Error("RATE_LIMIT_SALT is not set");
      handler = createHandler({
        db: getFirestore(),
        siteUrl,
        salt,
        procedureIds: procedureIndex(`${siteUrl}/procedures.json`),
        devOrigins: process.env.FUNCTIONS_EMULATOR === "true",
      });
    }
    return handler(req, res);
  },
);
