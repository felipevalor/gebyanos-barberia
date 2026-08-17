import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { uuidv7 } from '../../src/db/id';
import {
  pemADer,
  firmarJwt,
  obtenerAccessToken,
  crearEvento,
  borrarEvento,
  leerCredenciales,
  calendarHabilitado,
  tituloEvento,
  descripcionEvento,
} from '../../src/services/gcal';
import {
  sincronizarAlta,
  sincronizarCancelacion,
  sincronizarReprogramacion,
  sinRomper,
} from '../../src/services/calendario-reservas';
import { hooksPorDefecto } from '../../src/services/hooks-reserva';
import { cancelarReserva } from '../../src/services/reservas-admin';

/**
 * Google Calendar sin Google.
 *
 * La firma RS256 se prueba DE VERDAD: se genera un par de claves, se firma el
 * JWT y se verifica con la clave publica. Un test que solo mirara que el
 * string tiene tres partes separadas por punto pasaria con una firma de basura.
 *
 * El resto —token, eventos— va contra un `fetch` interceptado, porque lo que
 * hay que fijar es QUE se le manda a Google y como se reacciona a lo que
 * contesta, no que Google exista.
 */

let PEM = '';
let clavePublica: CryptoKey;

const BARBERO = '01930000-0000-7000-8000-0000000e0001';
const SIN_CALENDARIO = '01930000-0000-7000-8000-0000000e0002';

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/** Igual que un archivo PEM real: 64 caracteres por linea. */
const aPem = (der: ArrayBuffer) =>
  `-----BEGIN PRIVATE KEY-----\n${b64(der).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);

  const par = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  PEM = aPem((await crypto.subtle.exportKey('pkcs8', par.privateKey)) as ArrayBuffer);
  clavePublica = par.publicKey;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, calendar_id) VALUES (?, 'congcal', 'Con Calendario', 'cal-1@group.calendar.google.com')",
    ).bind(BARBERO),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, calendar_id) VALUES (?, 'sincal', 'Sin Calendario', NULL)",
    ).bind(SIN_CALENDARIO),
  ]);
});

beforeEach(async () => {
  env.GOOGLE_SA_EMAIL = 'barberia@proyecto.iam.gserviceaccount.com';
  env.GOOGLE_SA_PRIVATE_KEY = PEM;

  await env.CACHE.delete('gcal:access-token');
  await env.DB.prepare('DELETE FROM reservas').run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Reserva sembrada directo en la base, sin pasar por el flujo de alta. */
async function sembrarReserva(o: {
  barberoId?: string;
  eventId?: string | null;
  turnoAuto?: boolean;
} = {}): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, calendar_event_id, turno_auto_iso)
     VALUES (?, ?, 'Juan Pérez', '+5493416513207', 'Corte', 30, '2027-04-01', '10:30', ?, ?)`,
  )
    .bind(
      id,
      o.barberoId ?? BARBERO,
      o.eventId ?? null,
      o.turnoAuto ? '2027-03-01T00:00:00.000Z' : null,
    )
    .run();
  return id;
}

/** `fetch` falso que devuelve respuestas en orden y registra los requests. */
function interceptar(respuestas: (Response | (() => Response))[]) {
  const llamadas: { url: string; init: RequestInit }[] = [];
  let i = 0;

  const falso = vi.fn(async (entrada: unknown, init: RequestInit = {}) => {
    llamadas.push({ url: String(entrada), init });
    const r = respuestas[Math.min(i++, respuestas.length - 1)];
    return typeof r === 'function' ? r() : r!.clone();
  });

  vi.stubGlobal('fetch', falso);
  return llamadas;
}

const respuestaToken = () =>
  new Response(JSON.stringify({ access_token: 'ya29.token-de-prueba', expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const respuestaEvento = (id = 'evt-123') =>
  new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// ==========================================================================

describe('credenciales', () => {
  it('sin las dos variables, la integración está apagada y NO es un error', () => {
    env.GOOGLE_SA_EMAIL = '';
    expect(leerCredenciales(env)).toBeNull();
    expect(calendarHabilitado(env)).toBe(false);

    env.GOOGLE_SA_EMAIL = 'algo@x.com';
    env.GOOGLE_SA_PRIVATE_KEY = '';
    expect(calendarHabilitado(env)).toBe(false);
  });

  it('con las dos, está habilitada', () => {
    expect(calendarHabilitado(env)).toBe(true);
    expect(leerCredenciales(env)?.email).toBe('barberia@proyecto.iam.gserviceaccount.com');
  });
});

describe('pemADer', () => {
  it('parsea un PEM normal, con saltos de línea reales', () => {
    expect(pemADer(PEM).byteLength).toBeGreaterThan(1000);
  });

  it('🔴 parsea un PEM con los saltos ESCAPADOS como \\n', () => {
    // Es como llega una private key pegada en un secret de Wrangler, y es el
    // error que hace perder una tarde: sin des-escapar, el base64 sale con
    // basura y importKey tira un error que no dice nada.
    const escapado = PEM.replace(/\n/g, '\\n');

    expect(escapado).toContain('\\n');
    expect(pemADer(escapado).byteLength).toBe(pemADer(PEM).byteLength);
  });

  it('tolera espacios y saltos de más', () => {
    expect(pemADer(`  ${PEM.replace(/\n/g, '\n\n')}  `).byteLength).toBe(pemADer(PEM).byteLength);
  });
});

describe('🔴 la firma RS256 es real', () => {
  it('el JWT verifica con la clave pública', async () => {
    const jwt = await firmarJwt(leerCredenciales(env)!, 1_800_000_000);
    const [header, claim, firma] = jwt.split('.');

    const deB64url = (s: string) => {
      const normal = s.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, '='));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    };

    const valida = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      clavePublica,
      deB64url(firma!),
      new TextEncoder().encode(`${header}.${claim}`),
    );

    expect(valida).toBe(true);
  });

  it('el claim tiene lo que Google exige, y expira en una hora', async () => {
    const ahora = 1_800_000_000;
    const jwt = await firmarJwt(leerCredenciales(env)!, ahora);
    const [header, claim] = jwt.split('.');

    const leer = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));

    expect(leer(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(leer(claim!)).toEqual({
      iss: 'barberia@proyecto.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      iat: ahora,
      // Google rechaza un JWT que pida mas de una hora.
      exp: ahora + 3600,
    });
  });

  it('la firma NO verifica si se toca el payload', async () => {
    const jwt = await firmarJwt(leerCredenciales(env)!, 1_800_000_000);
    const [header, , firma] = jwt.split('.');
    const otroClaim = btoa(JSON.stringify({ iss: 'atacante@x.com' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const deB64url = (s: string) => {
      const normal = s.replace(/-/g, '+').replace(/_/g, '/');
      return Uint8Array.from(atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, '=')), (c) =>
        c.charCodeAt(0),
      );
    };

    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        clavePublica,
        deB64url(firma!),
        new TextEncoder().encode(`${header}.${otroClaim}`),
      ),
    ).toBe(false);
  });
});

describe('el access token se cachea', () => {
  it('🔴 dos llamadas seguidas piden UN solo token', async () => {
    const llamadas = interceptar([respuestaToken()]);

    expect(await obtenerAccessToken(env)).toBe('ya29.token-de-prueba');
    expect(await obtenerAccessToken(env)).toBe('ya29.token-de-prueba');

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]?.url).toBe('https://oauth2.googleapis.com/token');
  });

  it('el body del canje es el grant de JWT bearer', async () => {
    const llamadas = interceptar([respuestaToken()]);
    await obtenerAccessToken(env);

    const body = llamadas[0]?.init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion')?.split('.')).toHaveLength(3);
  });

  it('un token a punto de vencer NO se reusa', async () => {
    // El margen es de 120 s: con 60 de vida, hay que pedir uno nuevo.
    await env.CACHE.put(
      'gcal:access-token',
      JSON.stringify({ token: 'viejo', venceMs: Date.now() + 60_000 }),
    );
    interceptar([respuestaToken()]);

    expect(await obtenerAccessToken(env)).toBe('ya29.token-de-prueba');
  });

  it('un token con vida de sobra sí se reusa', async () => {
    await env.CACHE.put(
      'gcal:access-token',
      JSON.stringify({ token: 'todavia-sirve', venceMs: Date.now() + 3_000_000 }),
    );
    const llamadas = interceptar([respuestaToken()]);

    expect(await obtenerAccessToken(env)).toBe('todavia-sirve');
    expect(llamadas).toHaveLength(0);
  });

  it('si Google rechaza el JWT devuelve null, no lanza', async () => {
    interceptar([
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ]);

    await expect(obtenerAccessToken(env)).resolves.toBeNull();
  });

  it('si la red falla devuelve null, no lanza', async () => {
    interceptar([
      () => {
        throw new TypeError('network error');
      },
    ]);

    await expect(obtenerAccessToken(env)).resolves.toBeNull();
  });
});

describe('crear evento', () => {
  it('🔴 el timezone va DOS veces: offset en el ISO y campo timeZone', async () => {
    // Es deliberado. Google interpreta el dateTime con su heuristica cuando
    // falta uno de los dos, y un turno corrido tres horas en el celular del
    // barbero se descubre tarde y mal.
    const llamadas = interceptar([respuestaToken(), respuestaEvento()]);

    await crearEvento(env, {
      calendarId: 'cal-1',
      summary: 'Juan Pérez - Corte',
      description: 'Tel: +5493416513207',
      fecha: '2027-04-01',
      hora: '10:30',
      duracionMin: 45,
    });

    const cuerpo = JSON.parse(llamadas[1]!.init.body as string);

    expect(cuerpo.start.dateTime).toBe('2027-04-01T10:30:00-03:00');
    expect(cuerpo.start.timeZone).toBe('America/Argentina/Buenos_Aires');
    expect(cuerpo.end.dateTime).toBe('2027-04-01T11:15:00-03:00');
    expect(cuerpo.end.timeZone).toBe('America/Argentina/Buenos_Aires');
    expect(cuerpo.summary).toBe('Juan Pérez - Corte');
    expect(cuerpo.description).toBe('Tel: +5493416513207');
  });

  it('el calendarId va escapado en la URL', async () => {
    // Los calendarId de Google llevan @ y a veces #.
    const llamadas = interceptar([respuestaToken(), respuestaEvento()]);

    await crearEvento(env, {
      calendarId: 'cal-1@group.calendar.google.com',
      summary: 'x',
      description: 'y',
      fecha: '2027-04-01',
      hora: '10:00',
      duracionMin: 30,
    });

    expect(llamadas[1]?.url).toContain('cal-1%40group.calendar.google.com');
  });

  it('devuelve el eventId de Google', async () => {
    interceptar([respuestaToken(), respuestaEvento('evt-abc')]);

    await expect(
      crearEvento(env, {
        calendarId: 'cal-1',
        summary: 'x',
        description: 'y',
        fecha: '2027-04-01',
        hora: '10:00',
        duracionMin: 30,
      }),
    ).resolves.toBe('evt-abc');
  });

  it('un 403 de Google devuelve null, no lanza', async () => {
    interceptar([respuestaToken(), new Response('forbidden', { status: 403 })]);

    await expect(
      crearEvento(env, {
        calendarId: 'cal-1',
        summary: 'x',
        description: 'y',
        fecha: '2027-04-01',
        hora: '10:00',
        duracionMin: 30,
      }),
    ).resolves.toBeNull();
  });
});

describe('borrar evento', () => {
  it('un 404 o un 410 cuentan como ÉXITO', async () => {
    // El objetivo es que el evento no exista, y no existe. Si contara como
    // fallo, cancelar dos veces —o cancelar un turno cuyo evento el barbero ya
    // borro a mano— quedaria como error para siempre.
    for (const status of [404, 410]) {
      interceptar([respuestaToken(), new Response(null, { status })]);
      await env.CACHE.delete('gcal:access-token');

      expect(await borrarEvento(env, 'cal-1', 'evt-1'), String(status)).toBe(true);
    }
  });

  it('un 500 cuenta como fallo', async () => {
    interceptar([respuestaToken(), new Response('boom', { status: 500 })]);
    expect(await borrarEvento(env, 'cal-1', 'evt-1')).toBe(false);
  });
});

describe('los títulos del evento', () => {
  it('un turno normal', () => {
    expect(tituloEvento('Juan Pérez', 'Corte')).toBe('Juan Pérez - Corte');
    expect(descripcionEvento('+5493416513207')).toBe('Tel: +5493416513207');
  });

  it('un turno de recurrente lleva (R) y "Generado Auto."', () => {
    expect(tituloEvento('Juan Pérez', 'Corte', true)).toBe('Juan Pérez (R) - Corte');
    expect(descripcionEvento('+5493416513207', true)).toBe('Generado Auto. Tel: +5493416513207');
  });
});

describe('sincronización con la reserva', () => {
  it('el alta guarda el calendar_event_id en la reserva', async () => {
    interceptar([respuestaToken(), respuestaEvento('evt-guardado')]);
    const id = await sembrarReserva();

    expect(await sincronizarAlta(env, id)).toBe('evt-guardado');

    const fila = await env.DB.prepare('SELECT calendar_event_id FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ calendar_event_id: string }>();
    expect(fila?.calendar_event_id).toBe('evt-guardado');
  });

  it('🔴 un barbero SIN calendar_id no dispara ningún request', async () => {
    const llamadas = interceptar([respuestaToken(), respuestaEvento()]);
    const id = await sembrarReserva({ barberoId: SIN_CALENDARIO });

    expect(await sincronizarAlta(env, id)).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it('🔴 sin credenciales tampoco: la integración está apagada entera', async () => {
    env.GOOGLE_SA_EMAIL = '';
    const llamadas = interceptar([respuestaToken(), respuestaEvento()]);
    const id = await sembrarReserva();

    expect(await sincronizarAlta(env, id)).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it('una reserva de recurrente lleva (R) en el título', async () => {
    const llamadas = interceptar([respuestaToken(), respuestaEvento()]);
    await sincronizarAlta(env, await sembrarReserva({ turnoAuto: true }));

    const cuerpo = JSON.parse(llamadas[1]!.init.body as string);
    expect(cuerpo.summary).toBe('Juan Pérez (R) - Corte');
    expect(cuerpo.description).toBe('Generado Auto. Tel: +5493416513207');
  });

  it('la cancelación borra el evento y limpia la columna', async () => {
    interceptar([respuestaToken(), new Response(null, { status: 204 })]);
    const id = await sembrarReserva({ eventId: 'evt-a-borrar' });

    expect(await sincronizarCancelacion(env, id)).toBe(true);

    const fila = await env.DB.prepare('SELECT calendar_event_id FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ calendar_event_id: string | null }>();
    expect(fila?.calendar_event_id).toBeNull();
  });

  it('🔴 si el borrado falla, el event_id NO se limpia', async () => {
    // Es el único rastro de que quedó un evento huérfano en el calendario del
    // barbero. Limpiarlo lo volvería invisible.
    interceptar([respuestaToken(), new Response('boom', { status: 500 })]);
    const id = await sembrarReserva({ eventId: 'evt-huerfano' });

    expect(await sincronizarCancelacion(env, id)).toBe(false);

    const fila = await env.DB.prepare('SELECT calendar_event_id FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ calendar_event_id: string | null }>();
    expect(fila?.calendar_event_id).toBe('evt-huerfano');
  });

  it('reprogramar borra el viejo y crea uno nuevo, en ese orden', async () => {
    const llamadas = interceptar([
      respuestaToken(),
      new Response(null, { status: 204 }),
      respuestaEvento('evt-nuevo'),
    ]);
    const id = await sembrarReserva({ eventId: 'evt-viejo' });

    expect(await sincronizarReprogramacion(env, id)).toBe('evt-nuevo');

    expect(llamadas[1]?.init.method).toBe('DELETE');
    expect(llamadas[1]?.url).toContain('evt-viejo');
    expect(llamadas[2]?.init.method).toBe('POST');

    const fila = await env.DB.prepare('SELECT calendar_event_id FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ calendar_event_id: string }>();
    expect(fila?.calendar_event_id).toBe('evt-nuevo');
  });

  it('si al reprogramar falla la creación, la columna queda en null', async () => {
    // El evento viejo ya no existe: dejar su id apuntaría a algo borrado.
    const respuestas = [
      respuestaToken(),
      new Response(null, { status: 204 }),
      new Response('boom', { status: 500 }),
    ];
    interceptar(respuestas);
    const id = await sembrarReserva({ eventId: 'evt-viejo' });

    expect(await sincronizarReprogramacion(env, id)).toBeNull();

    const fila = await env.DB.prepare('SELECT calendar_event_id FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ calendar_event_id: string | null }>();
    expect(fila?.calendar_event_id).toBeNull();
  });
});

describe('🔴 la regla de oro: nunca tirar una reserva por una integración caída', () => {
  it('el hook post-reserva no propaga NADA aunque Google explote', async () => {
    interceptar([
      () => {
        throw new Error('Google se cayó');
      },
    ]);
    const id = await sembrarReserva();

    // Si esto lanzara, `crearReserva` devolveria 500 sobre una reserva que ya
    // esta confirmada en la base: el cliente ve un error y el turno existe.
    await expect(
      hooksPorDefecto.ejecutar(env, {
        reservaId: id,
        barberoId: BARBERO,
        calendarId: 'cal-1',
        fecha: '2027-04-01',
        hora: '10:30',
        duracionMin: 30,
        servicio: 'Corte',
        nombre: 'Juan Pérez',
        telefono: '+5493416513207',
        telefonoEnmascarado: '****3207',
      }),
    ).resolves.toBeUndefined();
  });

  it('🔴 sinRomper se traga lo que `borrarEvento` NO atrapa', async () => {
    // Verificado por mutacion: sacar `sinRomper` de `cancelarReserva` no rompia
    // ningun test, porque `borrarEvento` ya atrapa sus propios errores de red.
    // O sea que el test de abajo prueba la red INTERNA, no esta.
    //
    // Lo que `sinRomper` cubre es lo otro: que falle la QUERY que busca los
    // datos de la reserva, o cualquier cosa que se agregue despues y se olvide
    // de atrapar. La garantia no puede depender de que cada pieza se acuerde.
    const avisos: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void avisos.push(a));

    await expect(
      sinRomper('prueba', 'reserva-1', async () => {
        throw new Error('la base explotó');
      }),
    ).resolves.toBeUndefined();

    expect(avisos).toHaveLength(1);
    expect(JSON.stringify(avisos[0])).toContain('la base explotó');
  });

  it('cancelar devuelve éxito aunque el borrado del evento falle', async () => {
    interceptar([
      () => {
        throw new Error('Google se cayó');
      },
    ]);
    const id = await sembrarReserva({ eventId: 'evt-1' });

    const r = await cancelarReserva(env, { barberoId: BARBERO, rol: 'barbero' }, id);
    expect(r.estado).toBe('exito');

    // Y la reserva quedó cancelada de verdad: es lo que le importa a la
    // disponibilidad, con o sin calendario.
    const fila = await env.DB.prepare('SELECT estado FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ estado: string }>();
    expect(fila?.estado).toBe('cancelada');
  });

  it('🔴 los logs no filtran el teléfono completo ni la private key', async () => {
    const avisos: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      avisos.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      avisos.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    });

    interceptar([respuestaToken(), new Response('boom', { status: 500 })]);
    await sincronizarAlta(env, await sembrarReserva());

    const todo = avisos.join('\n');
    expect(todo.length).toBeGreaterThan(0);
    expect(todo).not.toContain('6513207');
    expect(todo).not.toContain('BEGIN PRIVATE KEY');
    expect(todo).not.toContain('ya29.token-de-prueba');
  });
});
