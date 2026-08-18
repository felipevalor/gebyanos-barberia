#!/usr/bin/env node
/**
 * Smoke check contra la URL REAL. Falla ruidosamente.
 *
 * ⚠️ EXISTE PORQUE EL SUITE DE TESTS NO PUEDE DETECTAR ESTO. Los tests corren
 * contra el codigo local: ninguno sabe qué version esta publicada, ni si la
 * base de produccion tiene datos, ni si faltan secrets. Produccion estuvo 15
 * commits atras sin que nadie lo viera, con 802 tests en verde.
 *
 * Uso:
 *   node scripts/smoke.mjs                    # compara contra el HEAD local
 *   node scripts/smoke.mjs <sha>              # compara contra un SHA puntual
 *
 * ⚠️ ESPERA A QUE PROPAGUE. Cloudflare despliega gradualmente: corriendo esto
 * a segundos del deploy, algunos requests todavia pegan contra el isolate
 * viejo. Paso de verdad — un POST devolvio 404 porque la ruta no existia en la
 * version anterior, y el mismo request 30 segundos despues dio 401. Por eso
 * cada chequeo reintenta.
 */
import { execSync } from 'node:child_process';

const URL_BASE = process.env.SMOKE_URL ?? 'https://gebyanos-barberia.valorsolutions.workers.dev';

const sha =
  process.argv[2] ?? execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

const REINTENTOS = 6;
const ESPERA_MS = 10_000;

const fallas = [];
const ok = (m) => console.log(`  ✅ ${m}`);
const mal = (m) => {
  fallas.push(m);
  console.log(`  ❌ ${m}`);
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reintenta hasta que `cumple` sea true o se acaben los intentos. */
async function conReintento(nombre, hacer, cumple) {
  for (let i = 1; i <= REINTENTOS; i++) {
    const r = await hacer();
    if (cumple(r)) return r;
    if (i < REINTENTOS) {
      console.log(`  ⏳ ${nombre}: intento ${i}/${REINTENTOS}, esperando propagación…`);
      await dormir(ESPERA_MS);
    }
  }
  return null;
}

const pedir = (p, init = {}) => fetch(URL_BASE + p, init);
const json = async (p) => (await (await pedir(p)).json()).data;

console.log(`\nSmoke check → ${URL_BASE}\nSHA esperado: ${sha}\n`);

// ── 1. la version desplegada es la que se cree
console.log('1. Versión desplegada');
const salud = await conReintento(
  'SHA',
  async () => (await pedir('/health')).json(),
  (h) => h?.version === sha,
);
if (salud) ok(`/health responde ${salud.version} (desplegado ${salud.deployedAt})`);
else {
  const actual = await (await pedir('/health')).json();
  mal(`el SHA desplegado es "${actual?.version}" y se esperaba "${sha}" — DRIFT`);
}

// ── 2. ningun endpoint del contrato da 404
console.log('\n2. Endpoints del contrato');
const rutas = [
  ['GET', '/api/negocio'], ['GET', '/api/barberos'], ['GET', '/api/servicios'],
  ['GET', '/api/promos'], ['GET', '/api/catalogo'],
  ['GET', '/api/mi-turno?token=x'], ['POST', '/api/mi-turno/buscar'],
  ['POST', '/api/mi-turno/access-link'], ['POST', '/api/mi-turno/cancel?token=x'],
  ['PUT', '/api/mi-turno?token=x'],
  ['GET', '/api/admin/me'], ['GET', '/api/admin/barberos'], ['GET', '/api/admin/servicios'],
  ['GET', '/api/admin/promos'], ['GET', '/api/admin/catalogo'],
  ['GET', '/api/admin/recurrentes'], ['GET', '/api/admin/avisos-fallidos'],
  ['GET', '/api/admin/callmebot'], ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/clientes'], ['GET', '/api/admin/agenda'],
  ['GET', '/api/admin/horarios'], ['GET', '/api/admin/feriados'],
];
const cuerpo = (m) =>
  m === 'GET' ? {} : { method: m, headers: { 'content-type': 'application/json' }, body: '{}' };

let con404 = 0;
for (const [m, p] of rutas) {
  const r = await conReintento(
    `${m} ${p}`,
    () => pedir(p, cuerpo(m)),
    (res) => res.status !== 404,
  );
  if (!r) {
    con404++;
    mal(`${m} ${p} → 404 (la ruta no existe en lo desplegado)`);
  }
}
if (con404 === 0) ok(`${rutas.length} endpoints, ninguno 404`);

// ── 3. los catalogos tienen datos
console.log('\n3. Catálogos');
for (const p of ['/api/servicios', '/api/barberos']) {
  const d = await json(p);
  if (Array.isArray(d) && d.length > 0) ok(`${p} → ${d.length}`);
  else mal(`${p} está VACÍO — el flujo público arranca acá y no puede empezar`);
}
for (const p of ['/api/promos', '/api/catalogo']) {
  const d = await json(p);
  console.log(`  ${d?.length ? '✅' : 'ℹ️ '} ${p} → ${d?.length ?? 0}${d?.length ? '' : ' (vacío; es vidriera, no bloquea reservar)'}`);
}

// ── 4. los secrets requeridos estan
console.log('\n4. Secrets requeridos');
// MAGIC_LINK_SECRET: sin el, `emitirToken` lanza y access-link da 500.
const link = await pedir('/api/mi-turno/access-link', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reservaId: 'no-existe', telefono: '3410000000' }),
});
if (link.status === 500) mal('MAGIC_LINK_SECRET falta o es corta: access-link devuelve 500');
else ok(`MAGIC_LINK_SECRET presente (access-link → ${link.status}, no 500)`);

// ── 5. el timezone no volvio a la respuesta
console.log('\n5. Contrato');
const neg = await json('/api/negocio');
if (neg?.timezone === undefined) ok('/api/negocio no expone timezone');
else mal('/api/negocio volvió a exponer timezone');

// ── cierre
console.log('');
if (fallas.length) {
  console.error(`❌ SMOKE CHECK FALLÓ — ${fallas.length} problema(s):`);
  for (const f of fallas) console.error(`   · ${f}`);
  process.exit(1);
}
console.log('✅ Smoke check OK\n');
