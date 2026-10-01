/**
 * Bytes -> text for fetched pages and local HTML files. Precedence follows the HTML standard: byte-order mark, then the HTTP
 * `Content-Type` charset, then `<meta charset>` / `<meta http-equiv="Content-Type">` in the first 4 KiB, then UTF-8.
 * `TextDecoder` implements the WHATWG encoding labels, so `iso-8859-1` and `windows-1252` (which browsers treat alike) just work.
 */

export interface ContentType {
  /** Lower-cased media type without parameters, `''` when the header is absent. */
  mediaType: string;
  charset?: string;
}

export function parseContentType(header: string | null | undefined): ContentType {
  if (!header) return { mediaType: '' };
  const [type = '', ...params] = header.split(';');
  const out: ContentType = { mediaType: type.trim().toLowerCase() };
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(p);
    if (m?.[1]) out.charset = m[1];
  }
  return out;
}

function supported(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

function bomCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return undefined;
}

function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head)?.[1];
}

export interface DecodeOptions {
  /** The raw `Content-Type` header, when there is one. */
  contentType?: string | null;
  /** Look for `<meta charset>` (HTML only). */
  sniffMeta: boolean;
}

export interface Decoded {
  text: string;
  charset: string;
  warnings: string[];
}

export function decodeBytes(bytes: Uint8Array, opts: DecodeOptions): Decoded {
  const warnings: string[] = [];
  const candidates: Array<{ label: string; where: string }> = [];
  const bom = bomCharset(bytes);
  if (bom) candidates.push({ label: bom, where: 'byte-order mark' });
  const header = parseContentType(opts.contentType).charset;
  if (header) candidates.push({ label: header, where: 'Content-Type header' });
  const meta = opts.sniffMeta ? metaCharset(bytes) : undefined;
  if (meta) candidates.push({ label: meta, where: '<meta> tag' });

  let charset = 'utf-8';
  for (const c of candidates) {
    if (supported(c.label)) {
      charset = c.label.toLowerCase();
      break;
    }
    warnings.push(`unknown charset "${c.label}" declared in the ${c.where}; decoded as UTF-8`);
  }
  return { text: new TextDecoder(charset).decode(bytes), charset, warnings };
}
