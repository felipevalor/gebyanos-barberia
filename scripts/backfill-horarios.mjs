#!/usr/bin/env node
/**
 * Siembra el horario inicial a los barberos que no tienen ninguno.
 *
 * POR QUE HACE FALTA
 *
 * `evaluarSlot` devuelve `diaCerrado` cuando un barbero no tiene bloques, y eso
 * es deliberado — ver src/services/horarios.ts. El alta de barberos siembra el
 * horario, pero los barberos creados ANTES de que existiera ese sembrado
 * quedaron sin ninguna fila, y un barbero sin horarios no ofrece ni un turno.
 *
 * Es idempotente: solo toca a los que tienen cero bloques.
 *
 *   node scripts/backfill-horarios.mjs --local
 *   node scripts/backfill-horarios.mjs --remote
 *   node scripts/backfill-horarios.mjs --remote --dry-run
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const WRANGLER = './node_modules/.bin/wrangler';
const BASE = 'barberia';

const args = process.argv.slice(2);
const remoto = args.includes('--remote');
const local = args.includes('--local');
const simulacro = args.includes('--dry-run');

if (remoto === local) {
  console.error('Usá exactamente uno: --local o --remote.');
  process.exit(1);
}

const destino = remoto ? '--remote' : '--local';

/** UUID v7: mismo formato que src/db/id.ts. */
function uuidv7() {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function consultar(sql) {
  const salida = execFileSync(
    WRANGLER,
    ['d1', 'execute', BASE, destino, '-y', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(salida)[0]?.results ?? [];
}

// Los que no tienen NINGUNA fila de horario. Incluye a los inactivos: si
// mañana se reactivan, tienen que tener horario igual.
const sinHorarios = consultar(`
  SELECT b.id, b.slug, b.activo
    FROM barberos b
   WHERE NOT EXISTS (SELECT 1 FROM barbero_horarios h WHERE h.barbero_id = b.id)
   ORDER BY b.slug
`);

if (sinHorarios.length === 0) {
  console.log(`✓ Todos los barberos tienen horarios en ${destino}. Nada que hacer.`);
  process.exit(0);
}

console.log(`Barberos sin horarios en ${destino}: ${sinHorarios.length}`);
for (const b of sinHorarios) {
  console.log(`  · ${b.slug}${b.activo ? '' : ' (inactivo)'}`);
}

// Los siete dias de 9 a 20, con domingo inactivo. Igual que
// sembrarHorarioInicial en src/services/horarios.ts.
const valores = sinHorarios.flatMap((b) =>
  [0, 1, 2, 3, 4, 5, 6].map(
    (dow) => `('${uuidv7()}', '${b.id}', ${dow}, ${dow === 0 ? 0 : 1}, 9, 20)`,
  ),
);

const sql =
  'INSERT INTO barbero_horarios (id, barbero_id, dow, activo, hora_inicio, hora_fin) VALUES\n' +
  valores.join(',\n') +
  ';';

if (simulacro) {
  console.log('\n--dry-run: no se escribe nada. SQL que se aplicaría:\n');
  console.log(sql);
  process.exit(0);
}

consultar(sql);
console.log(`\n✓ ${valores.length} filas insertadas (${sinHorarios.length} barberos × 7 días).`);

// Verificacion: que ninguno haya quedado sin horarios.
const restantes = consultar(`
  SELECT COUNT(*) AS n FROM barberos b
   WHERE NOT EXISTS (SELECT 1 FROM barbero_horarios h WHERE h.barbero_id = b.id)
`);

const quedan = restantes[0]?.n ?? -1;
if (quedan !== 0) {
  console.error(`✘ Quedaron ${quedan} barberos sin horarios.`);
  process.exit(1);
}
console.log('✓ Verificado: no queda ningún barbero sin horarios.');
