// agentry/src/handlers/_installer_import.mjs
//
// v0.16.3 — re-export prepareSession so seed handlers can call it
// without hardcoding an absolute path. Synthesized handlers get the
// absolute path baked in at synth time (because they may live outside
// the package directory). Seeds live inside the package, so they can
// import via a relative path.
export { prepareSession } from "../runtime/installer.mjs";
