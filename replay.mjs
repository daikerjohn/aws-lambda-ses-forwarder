import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const replay = require("./replay.cjs");

export const replayFromEventFile = replay.replayFromEventFile;
export const replayFromEventFileCli = replay.replayFromEventFileCli;
export const loadJsonFile = replay.loadJsonFile;
export default replay;
