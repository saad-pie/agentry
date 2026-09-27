// agentry/src/handlers/_register.mjs
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname, basename } from "node:path";
import { registerHandler } from "../invokers/in_process_js.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname).filter(f => f.endsWith(".mjs") && !f.startsWith("_") && f !== "watcher.polling.mjs");

export const registered = [];
for (const file of files) {
  const id = basename(file, ".mjs");
  const mod = await import(pathToFileURL(join(__dirname, file)).href);
  const fn = mod.default || mod.handler;
  if (typeof fn === "function") { registerHandler(id, fn); registered.push(id); }
}

{
  const mod = await import(pathToFileURL(join(__dirname, "watcher.polling.mjs")).href);
  if (typeof mod.default === "function") { registerHandler("watcher.polling", mod.default); registered.push("watcher.polling"); }
}
