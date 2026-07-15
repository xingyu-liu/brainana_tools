// Minimal GIFTI (.func.gii / .shape.gii) reader → per-DataArray Float32Array frames.
// Handles Base64Binary and GZipBase64Binary (zlib) encodings via fflate (browser-safe).
// Only what the viewer needs: NIFTI_TYPE_FLOAT32 scalar arrays.
import { unzlibSync, gunzipSync } from 'fflate'

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64) // available in browsers and Node >= 16
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decode(bytes: Uint8Array, encoding: string): Uint8Array {
  if (/gzip/i.test(encoding)) {
    // GIFTI "GZipBase64Binary" is zlib-wrapped; fall back to gzip if needed.
    try {
      return unzlibSync(bytes)
    } catch {
      return gunzipSync(bytes)
    }
  }
  return bytes
}

// Parse every FLOAT32 DataArray into a Float32Array (one per frame/array).
export function parseGiftiFloat32(text: string): Float32Array[] {
  const out: Float32Array[] = []
  const arrayRe = /<DataArray\b([^>]*)>([\s\S]*?)<\/DataArray>/g
  let m: RegExpExecArray | null
  while ((m = arrayRe.exec(text)) !== null) {
    const attrs = m[1]
    const body = m[2]
    const encoding = (attrs.match(/Encoding="([^"]+)"/) || [])[1] || 'Base64Binary'
    const dataMatch = body.match(/<Data>([\s\S]*?)<\/Data>/)
    if (!dataMatch) continue
    const raw = decode(base64ToBytes(dataMatch[1].trim()), encoding)
    out.push(new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4)))
  }
  return out
}
