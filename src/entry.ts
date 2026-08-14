// The entry point. Registers every OCR backend the plugin has, then hands Obsidian the plugin class.
// There is one build and one `main.js`: the paid backends ship to everyone and are unlocked at
// runtime by the licence, so a second entry point would only be a second thing to keep in step.
import "./vision-register";
// Registered after Vision so it sits below it in the dropdown (spec §6.5). Vision stays the
// zero-config default on macOS; this one is a deliberate choice in settings and never a default.
import "./local-register";
// Last, so the three servers-you-run-yourself sit below both (free-localhost-ocr spec §2.3). These
// are the only backends that register on every platform, which is what finally gives a Windows x64
// or Linux user something selectable.
import "./localhost-register";
// Last, and licence-gated: the four cloud providers. They register unconditionally so that they are
// visible and explicable in settings — a backend that vanishes teaches nobody that Pro exists — and
// refuse to run without a licence, falling back with a message.
import "../pro/llm-register";

export { default } from "./main";
