import { randomBytes } from "node:crypto";

// What stands for a report in the published figures: random, so the id the
// sender gets as a receipt can't find it there.
export const newMark = (): string => randomBytes(6).toString("hex");
