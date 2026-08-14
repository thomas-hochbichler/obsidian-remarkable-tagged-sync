// Moved to `src/llm-transcript.ts` and re-exported here so no Pro call site changes.
//
// Why the prompt moved: the free build's local model backend (managed-local-llm-ocr spec §3.2) must
// send the **same prompt, verbatim** -- four alternatives were measured and every one was equal or
// worse, and the short literal arm collapsed to 836.8 % CER on one page, so the boilerplate is
// load-bearing. The free build cannot import from `pro/`, which is absent from a plain checkout, and
// a second copy of a prompt that must stay identical is a regression waiting for someone to edit one
// of them.
//
// `sanitizeTranscript` travels with it because §3.2's other half is that it does **not** strip a
// descriptive preamble -- it matches only a tight "Here is the transcript". The defence is the prompt;
// anyone editing either has to see both.
//
// Why the *call machinery* followed on 2026-08-09: the free build gained an OpenAI-compatible
// localhost backend (free-localhost-ocr spec §2), which is the same adapter making the same requests
// -- so `fetchWithRetry` and `transcribePages` could no longer live on a side the free build cannot
// import from. Nothing about them changed for Pro.

export {
	fetchWithRetry,
	LLM_MAX_PARALLELISM,
	sanitizeTranscript,
	transcribePages,
	TRANSCRIPTION_PROMPT,
	typedText,
	type LlmPageOutcome,
	type Sleep,
} from "../src/llm-transcript";
