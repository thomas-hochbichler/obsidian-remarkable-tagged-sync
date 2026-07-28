// Free build entry point. Registers the OCR backends that ship to everyone, then hands Obsidian the
// plugin class. An optional separate entry point can register further backends on top of these.
// Nothing in `src/` may reference it — that is what lets this build stand alone.
import "./vision-register";

export { default } from "./main";
