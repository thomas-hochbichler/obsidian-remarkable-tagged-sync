// Free build entry point. Registers the OCR backends that ship to everyone, then hands Obsidian the
// plugin class. An optional separate entry point can register further backends on top of these.
// Nothing in `src/` may reference it — that is what lets this build stand alone.
import "./vision-register";
// Registered after Vision so it sits below it in the dropdown (spec §6.5). Vision stays the
// zero-config default on macOS; this one is a deliberate choice in settings and never a default.
import "./local-register";
// Last, so the three servers-you-run-yourself sit below both (free-localhost-ocr spec §2.3). These
// are the only backends that register on every platform, which is what finally gives a Windows x64
// or Linux user something selectable.
import "./localhost-register";

export { default } from "./main";
