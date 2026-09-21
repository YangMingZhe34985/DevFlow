import { pathToFileURL } from "node:url";
import path from "node:path";

const workspace = process.argv[2];
const { workForever } = await import(pathToFileURL(path.join(workspace, "worker.mjs")));
workForever();
