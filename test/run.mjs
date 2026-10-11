// Bundles test/agent.test.ts with esbuild (ships with wrangler) and runs it in Node.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "dash-test-")), "agent.test.mjs");
await build({
  entryPoints: [new URL("./agent.test.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  logLevel: "warning",
});
await import(pathToFileURL(out).href);
