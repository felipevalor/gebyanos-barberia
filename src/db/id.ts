/**
 * UUID v7: 48 bits de timestamp Unix en ms + 74 bits aleatorios.
 *
 * Se usa como PK de todas las tablas porque es ordenable por tiempo — a
 * diferencia del v4 — asi que el orden de insercion coincide con el orden del
 * indice y las queries por rango de creacion no fragmentan el B-tree.
 *
 * Layout (RFC 9562):
 *   0-5   timestamp big-endian (48 bits)
 *   6     version 7 en los 4 bits altos + random
 *   7     random
 *   8     variante 0b10 en los 2 bits altos + random
 *   9-15  random
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Timestamp en los primeros 6 bytes.
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC 4122

  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
  const s = hex.join('');

  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
