// The pi checkout arbiter drives: ARBITER_PI if set, else the `pi` directory next to arbiter.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_ROOT = process.env.ARBITER_PI ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi");
