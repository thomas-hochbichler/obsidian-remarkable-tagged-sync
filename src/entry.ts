// Free build entry point. Registers the OCR backends that ship to everyone, then hands Obsidian the
// plugin class. An optional separate entry point can register further backends on top of these.
// Nothing in `src/` may reference it — that is what lets this build stand alone.
import "./vision-register";
// Registered after Vision so it sits below it in the dropdown (spec §6.5). Vision stays the
// zero-config default on macOS; this one is a deliberate choice in settings and never a default.
import "./local-register";

export { default } from "./main";
