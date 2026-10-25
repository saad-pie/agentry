// agentry/src/handlers/synthesize/config.mjs
// v0.53.0 — extracted from agentry.synthesize.mjs.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const HANDLERS_DIR = process.env.AGENTRY_HANDLERS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/handlers";
export const SEEDS_DIR = process.env.AGENTRY_SEEDS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/seeds";
export const MAX_README_CHARS = 12000;
export const MAX_MANIFEST_CHARS = 4000;

export const INSTALLER_PATH = join(HERE, "..", "..", "runtime", "installer.mjs").replace(/\\/g, "/");
export const SKILL_RUNNER_PATH = join(HERE, "..", "..", "runtime", "skill_runner.mjs").replace(/\\/g, "/");

export const MODEL_CHAIN = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "google", model: "gemini-2.5-flash" },
];

