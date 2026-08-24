// Build shim: replaces the optional `cpu-features` native addon that `ssh2` probes for.
//
// ssh2 uses it to pick the fastest cipher for the CPU it is on, and asks for it inside a
// `try {} catch {}` precisely because it is optional -- without it, ssh2 runs its pure-JS
// implementation, which is what this plugin has always been going to use anyway: a native addon
// cannot be shipped inside `main.js`, and building one on the user's machine is not something a
// note-syncing plugin gets to ask for.
//
// Throwing rather than exporting a stub is deliberate. ssh2 decides the accelerator is present with
// `!!binding`, so an empty object would read as "available" and then fail on the first cipher.
// Throwing is exactly what an absent module does, and it lands in the `catch` ssh2 already has.

throw new Error("Tagged Sync: cpu-features is deliberately not bundled; ssh2 falls back to pure JS.");
