#!/usr/bin/env node
/**
 * Genera un hash PBKDF2 en el formato exacto que espera `verificarPassword`.
 *
 * ⚠️ ES LA UNICA PUERTA cuando un barbero queda afuera del panel: el endpoint
 * que cambia la password exige estar logueado, asi que un hash corrupto —o una
 * password perdida— no se arregla desde la aplicacion. Ver el README, seccion
 * "Emergencia: el owner no puede entrar".
 *
 * Formato: pbkdf2$<iteraciones>$<salt-b64>$<hash-b64>
 *
 * Tiene que coincidir carácter por carácter con `src/services/password.ts`:
 * mismo separador, mismo esquema, misma cantidad de iteraciones, SHA-256, y
 * 32 bytes derivados. Un hash con otra forma no falla al escribirlo — falla
 * despues, en el login, y ahi ya nadie relaciona las dos cosas.
 *
 * Uso:
 *   node scripts/hash-password.mjs 'la-password-nueva'
 *
 * La password se pasa como argumento y NO se guarda en ningun lado. Queda en
 * el historial del shell: borrala despues, o usá un espacio adelante del
 * comando si tu shell lo respeta.
 */
import { webcrypto as crypto } from 'node:crypto';

/** Los tres tienen que ser los mismos que en src/services/password.ts. */
const ESQUEMA = 'pbkdf2';
const ITERACIONES = 50_000;
const LARGO_SALT = 16;
const LARGO_HASH = 32;
const LARGO_MIN_PASSWORD = 12;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

const password = process.argv[2];

if (!password) {
  console.error("Falta la password.\n\n  node scripts/hash-password.mjs 'la-password-nueva'\n");
  process.exit(1);
}

if (password.length < LARGO_MIN_PASSWORD) {
  console.error(
    `La password tiene que tener al menos ${LARGO_MIN_PASSWORD} caracteres (tiene ${password.length}).`,
  );
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(LARGO_SALT));

const material = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(password),
  'PBKDF2',
  false,
  ['deriveBits'],
);

const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: ITERACIONES, hash: 'SHA-256' },
  material,
  LARGO_HASH * 8,
);

const hash = `${ESQUEMA}$${ITERACIONES}$${b64(salt)}$${b64(new Uint8Array(bits))}`;

// El hash va SOLO a stdout, para poder pipearlo sin arrastrar las
// instrucciones. Todo lo demas va a stderr.
console.error('\nHash generado. Para escribirlo en la base REMOTA:\n');
console.error(
  `  ./node_modules/.bin/wrangler d1 execute barberia --remote --command \\\n` +
    `    "UPDATE barberos SET password_hash = '${hash}' WHERE slug = 'EL-SLUG'"\n`,
);
console.error('Sacá --remote para probarlo contra la base local primero.\n');
console.log(hash);
