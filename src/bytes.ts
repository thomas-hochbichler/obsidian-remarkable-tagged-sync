export function toArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data;
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
