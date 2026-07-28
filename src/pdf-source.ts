import { PDFDocument } from "pdf-lib";

/**
 * Guard for the uploaded source PDF of a PDF-backed document (`content.fileType === "pdf"`), fetched
 * via `getPdf` before it's composited with its handwritten annotations (see `renderAnnotatedPdf`).
 * An empty or pageless source is a failed sync, not a valid empty note.
 */
export async function validateSourcePdf(bytes: Uint8Array): Promise<Uint8Array> {
	if (bytes.length === 0) throw new Error("source PDF is empty");
	const doc = await PDFDocument.load(bytes);
	if (doc.getPageCount() === 0) throw new Error("source PDF has no pages");
	return bytes;
}
