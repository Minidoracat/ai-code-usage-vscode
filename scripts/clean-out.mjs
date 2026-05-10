import { rm } from "node:fs/promises";

await rm("out", { force: true, recursive: true });
