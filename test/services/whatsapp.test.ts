import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { uuidv7 } from '../../src/db/id';
import {
  armarMensaje,
  interpretarRespuesta,
  limpiarDetalle,
  enviarWhatsApp,
  esTelefonoInternacional,
  ERROR_TELEFONO_INVALIDO,
  NOTAS,
} from '../../src/services/whatsapp';
import {
  procesarAviso,
  procesarBatch,
  registrarFallo,
  listarAvisosFallidos,
  descartarAvisoFallido,
  destinoDelBarbero,
  avisarCambio,
  MAX_INTENTOS,
  type MensajeAviso,
} from '../../src/services/notificaciones';

const BARBERO = '01930000-0000-7000-8000-0000000d0001';
const SIN_CALLMEBOT = '01930000-0000-7000-8000-0000000d0002';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, callmebot_phone, callmebot_apikey) VALUES (?, 'conwa', 'Con WA', '+5493416513207', 'key-del-barbero')",
    ).bind(BARBERO),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, callmebot_phone, callmebot_apikey) VALUES (?, 'sinwa', 'Sin WA', NULL, NULL)",
    ).bind(SIN_CALLMEBOT),
  ]);
});

beforeEach(async () => {
  env.CALLMEBOT_APIKEY = '';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM avisos_fallidos'),
    env.DB.prepare('DELETE FROM reservas'),
  ]);

  RESERVA = uuidv7();
  await env.DB.prepare(
    `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora)
     VALUES (?, ?, 'Juan Pérez', '+5493416513207', 'Corte', 30, '2027-04-01', '10:30')`,
  )
    .bind(RESERVA, BARBERO)
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function interceptar(respuestas: (Response | (() => Response))[]) {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (entrada: unknown) => {
      urls.push(String(entrada));
      const r = respuestas[Math.min(i++, respuestas.length - 1)];
      return typeof r === 'function' ? r() : r!.clone();
    }),
  );
  return urls;
}

let RESERVA = '';

const mensaje = (over: Partial<MensajeAviso> = {}): MensajeAviso => ({
  clase: 'whatsapp',
  reservaId: RESERVA,
  barberoId: BARBERO,
  aviso: {
    tipo: 'creada',
    nombre: 'Juan Pérez',
    telefono: '+5493416513207',
    servicio: 'Corte',
    fecha: '2027-04-01',
    hora: '10:30',
    extra: NOTAS.web,
  },
  ...over,
});

// ==========================================================================

describe('🔴 CallMeBot devuelve 200 aunque falle', () => {
  /**
   * Es lo menos obvio de la integración: el status miente y el error viene en
   * prosa dentro del cuerpo. Un cliente que mire el código da por enviado un
   * mensaje que nunca salió.
   */
  const cuerposDeFallo = [
    'ERROR: You need to ask for an API key first',
    'APIKey is invalid',
    'The phone number is not registered in the bot',
    'This action is not allowed',
    'Invalid phone number',
    'This API is no longer available',
    'You need to activate the bot first',
    'Wrong apikey',
    'Message failed to send',
  ];

  for (const cuerpo of cuerposDeFallo) {
    it(`200 + "${cuerpo.slice(0, 32)}…" es un FALLO`, () => {
      expect(interpretarRespuesta(200, cuerpo).ok).toBe(false);
    });
  }

  it('un 200 con un cuerpo de éxito sí es éxito', () => {
    expect(interpretarRespuesta(200, 'Message queued. You will receive it in a few seconds.').ok).toBe(
      true,
    );
    expect(interpretarRespuesta(200, '').ok).toBe(true);
  });

  it('la detección es case-insensitive', () => {
    expect(interpretarRespuesta(200, 'ERROR').ok).toBe(false);
    expect(interpretarRespuesta(200, 'error').ok).toBe(false);
    expect(interpretarRespuesta(200, 'ErRoR').ok).toBe(false);
  });

  it('el motivo de un 200-que-falla es el texto de CallMeBot, sin inventar nada', () => {
    const r = interpretarRespuesta(200, '<b>APIKey</b> is invalid');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe('APIKey is invalid');
  });

  it('un status no-2xx tiene su propio mensaje', () => {
    const r = interpretarRespuesta(503, '<html>Service Unavailable</html>');
    expect(r.ok === false && r.motivo).toBe('CallMeBot respondió HTTP 503: Service Unavailable');
  });
});

describe('limpiarDetalle', () => {
  it('saca el HTML y aprieta los espacios', () => {
    expect(limpiarDetalle('<p>Hola   <b>mundo</b></p>\n\n')).toBe('Hola mundo');
  });

  it('trunca a 300 caracteres', () => {
    expect(limpiarDetalle('x'.repeat(500))).toHaveLength(300);
  });
});

describe('validación de teléfono', () => {
  it('acepta formato internacional con y sin +', () => {
    expect(esTelefonoInternacional('+5493416513207')).toBe(true);
    expect(esTelefonoInternacional('5493416513207')).toBe(true);
    expect(esTelefonoInternacional('1234567')).toBe(true);
    expect(esTelefonoInternacional('123456789012345')).toBe(true);
  });

  it('rechaza lo que no lo es', () => {
    for (const t of ['123456', '1234567890123456', '+54 9 341 651-3207', 'abc', '', null]) {
      expect(esTelefonoInternacional(t), String(t)).toBe(false);
    }
  });

  it('🔴 un teléfono inválido NO dispara el request y da el mensaje exacto', async () => {
    const urls = interceptar([new Response('ok')]);

    const r = await enviarWhatsApp({ telefono: 'no-es-un-numero', apikey: 'k' }, 'texto');

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe(ERROR_TELEFONO_INVALIDO);
    expect(urls).toHaveLength(0);
  });
});

describe('🔴 el template, carácter por carácter', () => {
  const base = {
    nombre: 'Juan Pérez',
    telefono: '+5493416513207',
    servicio: 'Corte',
    fecha: '2027-04-01',
    hora: '10:30',
  };

  it('una reserva nueva', () => {
    expect(armarMensaje({ ...base, tipo: 'creada', extra: NOTAS.web })).toBe(
      [
        '✅ Nueva reserva:',
        '  Nombre:   Juan Pérez',
        '  Tel:      +5493416513207',
        '  Servicio: Corte',
        '  Fecha:    2027-04-01 10:30',
        '  Nota:     Reserva confirmada vía Web.',
      ].join('\n'),
    );
  });

  it('sin extra, la línea de Nota no aparece', () => {
    const texto = armarMensaje({ ...base, tipo: 'creada' });

    expect(texto).not.toContain('Nota:');
    expect(texto.split('\n')).toHaveLength(5);
  });

  it('los tres títulos, con sus emojis', () => {
    expect(armarMensaje({ ...base, tipo: 'creada' }).split('\n')[0]).toBe('✅ Nueva reserva:');
    expect(armarMensaje({ ...base, tipo: 'cancelada' }).split('\n')[0]).toBe('❌ Turno cancelado:');
    expect(armarMensaje({ ...base, tipo: 'modificada' }).split('\n')[0]).toBe('✏️ Turno modificado:');
  });

  it('🐛 `recurrente` comparte título con `creada`, y se distingue por la nota', () => {
    // El sistema viejo elegía el título buscando substrings en el texto del
    // extra. Acá el tipo es explícito: un cliente que se llame "Reagendado" no
    // cambia el título de su propio mensaje.
    expect(armarMensaje({ ...base, tipo: 'recurrente' }).split('\n')[0]).toBe('✅ Nueva reserva:');

    const texto = armarMensaje({ ...base, tipo: 'recurrente', extra: NOTAS.recurrente });
    expect(texto).toContain('Nota:     Tu turno recurrente ha sido cargado.');
  });

  it('🐛 el título NO depende del contenido: un nombre "CANCELADO" no lo cambia', () => {
    const texto = armarMensaje({ ...base, nombre: 'CANCELADO', tipo: 'creada' });

    expect(texto.split('\n')[0]).toBe('✅ Nueva reserva:');
  });

  it('las etiquetas quedan alineadas en la misma columna', () => {
    const lineas = armarMensaje({ ...base, tipo: 'creada', extra: 'x' }).split('\n').slice(1);
    const columnas = lineas.map((l) => l.indexOf(l.trim().split(/\s{2,}|: /)[1] ?? ''));

    for (const l of lineas) expect(l.slice(0, 2)).toBe('  ');
    expect(new Set(lineas.map((l) => l.length - l.trimStart().length)).size).toBe(1);
    expect(columnas.length).toBe(5);
  });
});

describe('el envío', () => {
  it('la apikey y el teléfono van en la query string', async () => {
    const urls = interceptar([new Response('Message queued')]);

    await enviarWhatsApp({ telefono: '+5493416513207', apikey: 'la-key' }, 'hola');

    expect(urls[0]).toContain('api.callmebot.com/whatsapp.php');
    expect(urls[0]).toContain('phone=%2B5493416513207');
    expect(urls[0]).toContain('apikey=la-key');
  });

  it('una excepción de red devuelve el motivo y NO propaga', async () => {
    interceptar([
      () => {
        throw new TypeError('network error');
      },
    ]);

    const r = await enviarWhatsApp({ telefono: '+5493416513207', apikey: 'k' }, 'hola');

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toBe('Excepción al contactar CallMeBot: network error');
  });
});

describe('el destino del aviso', () => {
  it('usa las credenciales del barbero si las tiene', async () => {
    await expect(destinoDelBarbero(env, BARBERO)).resolves.toEqual({
      telefono: '+5493416513207',
      apikey: 'key-del-barbero',
    });
  });

  it('cae al fallback global cuando el barbero no tiene key', async () => {
    env.CALLMEBOT_APIKEY = 'key-de-la-casa';
    await env.DB.prepare('UPDATE barberos SET callmebot_apikey = NULL WHERE id = ?')
      .bind(BARBERO)
      .run();

    await expect(destinoDelBarbero(env, BARBERO)).resolves.toEqual({
      telefono: '+5493416513207',
      apikey: 'key-de-la-casa',
    });

    await env.DB.prepare("UPDATE barberos SET callmebot_apikey = 'key-del-barbero' WHERE id = ?")
      .bind(BARBERO)
      .run();
  });

  it('sin teléfono no hay destino, ni con fallback global', async () => {
    env.CALLMEBOT_APIKEY = 'key-de-la-casa';
    await expect(destinoDelBarbero(env, SIN_CALLMEBOT)).resolves.toBeNull();
  });

  it('la key del barbero se descifra con la función inyectada', async () => {
    const descifrar = vi.fn(async (v: string) => `descifrada:${v}`);

    await expect(destinoDelBarbero(env, BARBERO, descifrar)).resolves.toEqual({
      telefono: '+5493416513207',
      apikey: 'descifrada:key-del-barbero',
    });
    expect(descifrar).toHaveBeenCalledWith('key-del-barbero');
  });
});

describe('el consumer', () => {
  it('un envío exitoso no deja rastro de fallo', async () => {
    interceptar([new Response('Message queued')]);

    const r = await procesarAviso(env, mensaje(), 1);
    expect(r).toEqual({ ok: true, reintentar: false });

    const { results } = await env.DB.prepare('SELECT id FROM avisos_fallidos').all();
    expect(results).toHaveLength(0);
  });

  it('🔴 un 200-que-falla se REINTENTA, no se da por bueno', async () => {
    interceptar([new Response('ERROR: apikey invalid')]);

    const r = await procesarAviso(env, mensaje(), 1);

    expect(r.ok).toBe(false);
    expect(r.reintentar).toBe(true);
  });

  it('🔴 agotados los intentos, queda registrado CON EL MOTIVO', async () => {
    // Es lo que el barbero ve en el panel. Un "falló" pelado no le dice si
    // tiene que renovar la apikey o registrar el número en el bot.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    interceptar([new Response('APIKey is invalid')]);

    const r = await procesarAviso(env, mensaje(), MAX_INTENTOS);
    expect(r.reintentar).toBe(false);

    const fila = await env.DB.prepare('SELECT * FROM avisos_fallidos').first<{
      motivo: string;
      tipo: string;
      intentos: number;
      resumen: string;
      reserva_id: string;
    }>();

    expect(fila?.motivo).toBe('APIKey is invalid');
    expect(fila?.tipo).toBe('creada');
    expect(fila?.intentos).toBe(MAX_INTENTOS);
    expect(fila?.reserva_id).toBe(RESERVA);
    // El resumen sobrevive al borrado de la reserva.
    expect(fila?.resumen).toBe('Juan Pérez — Corte — 2027-04-01 10:30');
  });

  it('antes del último intento NO registra: se registraría tres veces', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    interceptar([new Response('ERROR')]);

    await procesarAviso(env, mensaje(), 1);
    await procesarAviso(env, mensaje(), 2);

    const { results } = await env.DB.prepare('SELECT id FROM avisos_fallidos').all();
    expect(results).toHaveLength(0);
  });

  it('un barbero sin CallMeBot no reintenta ni registra: no usó la función', async () => {
    const urls = interceptar([new Response('ok')]);

    const r = await procesarAviso(env, mensaje({ barberoId: SIN_CALLMEBOT }), 1);

    expect(r).toEqual({ ok: false, reintentar: false });
    expect(urls).toHaveLength(0);

    const { results } = await env.DB.prepare('SELECT id FROM avisos_fallidos').all();
    expect(results).toHaveLength(0);
  });

  it('🔴 ack y retry van por MENSAJE, no por batch', async () => {
    // Un aviso que falla no puede arrastrar a los otros nueve del batch: esos
    // ya se enviaron y llegarían duplicados.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    interceptar([new Response('Message queued'), new Response('ERROR: apikey')]);

    const uno = { id: 'm1', body: mensaje(), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const dos = { id: 'm2', body: mensaje(), attempts: 1, ack: vi.fn(), retry: vi.fn() };

    await procesarBatch(env, { messages: [uno, dos] } as unknown as MessageBatch<unknown>);

    expect(uno.ack).toHaveBeenCalledOnce();
    expect(uno.retry).not.toHaveBeenCalled();
    expect(dos.retry).toHaveBeenCalledOnce();
    expect(dos.ack).not.toHaveBeenCalled();
  });

  it('un mensaje desconocido se descarta, no se reintenta para siempre', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raro = { id: 'm3', body: { hola: 'mundo' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };

    await procesarBatch(env, { messages: [raro] } as unknown as MessageBatch<unknown>);

    expect(raro.ack).toHaveBeenCalledOnce();
    expect(raro.retry).not.toHaveBeenCalled();
  });

  it('una excepción inesperada no cuelga el batch entero', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    interceptar([
      () => {
        throw new Error('boom');
      },
    ]);
    const uno = { id: 'm1', body: mensaje(), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const dos = { id: 'm2', body: mensaje(), attempts: 1, ack: vi.fn(), retry: vi.fn() };

    await procesarBatch(env, { messages: [uno, dos] } as unknown as MessageBatch<unknown>);

    // Los dos quedaron resueltos: ninguno quedó sin ack ni retry.
    for (const m of [uno, dos]) {
      expect(m.ack.mock.calls.length + m.retry.mock.calls.length).toBe(1);
    }
  });
});

describe('🔴 los logs no filtran nada', () => {
  it('ni la apikey ni el teléfono completo', async () => {
    const salida: string[] = [];
    const capturar = (...a: unknown[]) =>
      void salida.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    vi.spyOn(console, 'warn').mockImplementation(capturar);
    vi.spyOn(console, 'error').mockImplementation(capturar);

    interceptar([new Response('ERROR: apikey invalid')]);
    await procesarAviso(env, mensaje(), MAX_INTENTOS);

    const todo = salida.join('\n');
    expect(todo.length).toBeGreaterThan(0);

    // La apikey va en la QUERY STRING porque CallMeBot no soporta header: un
    // log de request completo la filtraría.
    expect(todo).not.toContain('key-del-barbero');
    expect(todo).not.toContain('api.callmebot.com');
    // Del teléfono, solo los últimos 4.
    expect(todo).not.toContain('+5493416513207');
    expect(todo).toContain('3207');
  });
});

describe('avisarCambio', () => {
  const sembrar = async (tipo = 'turno') => {
    const id = uuidv7();
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, tipo)
       VALUES (?, ?, 'Ana López', '+5493415551234', 'Barba', 30, '2027-05-02', '16:00', ?)`,
    )
      .bind(id, BARBERO, tipo)
      .run();
    return id;
  };

  it('encola con los datos FRESCOS de la base', async () => {
    const enviados: MensajeAviso[] = [];
    vi.spyOn(env.NOTIFICACIONES, 'send').mockImplementation(async (m: unknown) => {
      enviados.push(m as MensajeAviso);
      return undefined as unknown as QueueSendResponse;
    });

    const id = await sembrar();
    await expect(avisarCambio(env, id, 'modificada', NOTAS.reagendadaPanel)).resolves.toBe(true);

    expect(enviados[0]?.aviso).toMatchObject({
      tipo: 'modificada',
      nombre: 'Ana López',
      fecha: '2027-05-02',
      hora: '16:00',
      extra: NOTAS.reagendadaPanel,
    });
  });

  it('🔴 un bloqueo administrativo NO avisa: no es el turno de nadie', async () => {
    const send = vi.spyOn(env.NOTIFICACIONES, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse);

    const id = await sembrar('bloqueo');
    await expect(avisarCambio(env, id, 'cancelada', NOTAS.canceladaPanel)).resolves.toBe(false);

    expect(send).not.toHaveBeenCalled();
  });

  it('una reserva inexistente no explota', async () => {
    vi.spyOn(env.NOTIFICACIONES, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse);
    await expect(avisarCambio(env, uuidv7(), 'cancelada', NOTAS.canceladaPanel)).resolves.toBe(false);
  });
});

describe('🔴 el registro sobrevive a un barbero borrado', () => {
  it('si la FK falla, la fila igual entra — sin referencias pero con el resumen', async () => {
    // Los mensajes viven hasta 24 h en la cola. En ese rato el barbero puede
    // haber sido borrado (`borrarBarbero` es un delete físico) y el INSERT
    // violaría la foreign key, perdiendo justo el registro que existe para que
    // nada se pierda en silencio.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await registrarFallo(
      env,
      mensaje({ reservaId: 'no-existe', barberoId: 'tampoco-existe' }),
      'APIKey is invalid',
      MAX_INTENTOS,
    );

    const fila = await env.DB.prepare('SELECT * FROM avisos_fallidos').first<{
      reserva_id: string | null;
      barbero_id: string | null;
      motivo: string;
      resumen: string;
    }>();

    expect(fila?.reserva_id).toBeNull();
    expect(fila?.barbero_id).toBeNull();
    // Lo que importa sigue estando: qué falló y de qué turno hablaba.
    expect(fila?.motivo).toBe('APIKey is invalid');
    expect(fila?.resumen).toBe('Juan Pérez — Corte — 2027-04-01 10:30');
  });
});

describe('el barbero puede ver lo que no salió', () => {
  const registrar = (barberoId: string | null, motivo: string) =>
    env.DB.prepare(
      "INSERT INTO avisos_fallidos (id, barbero_id, tipo, motivo, intentos, resumen) VALUES (?, ?, 'creada', ?, 3, 'X — Corte — 2027-04-01 10:00')",
    ).bind(uuidv7(), barberoId, motivo);

  it('un barbero ve solo los suyos; el owner ve todos', async () => {
    await env.DB.batch([
      registrar(BARBERO, 'APIKey is invalid'),
      registrar(SIN_CALLMEBOT, 'not registered'),
      registrar(null, 'huérfano de un barbero borrado'),
    ]);

    expect(await listarAvisosFallidos(env, BARBERO)).toHaveLength(1);
    expect(await listarAvisosFallidos(env, null)).toHaveLength(3);
  });

  it('el motivo llega crudo: es lo que hace accionable el registro', async () => {
    await registrar(BARBERO, 'APIKey is invalid').run();

    const [aviso] = await listarAvisosFallidos(env, BARBERO);
    expect(aviso?.motivo).toBe('APIKey is invalid');
    expect(aviso?.intentos).toBe(3);
  });

  it('🔴 un barbero no puede descartar el aviso de otro', async () => {
    await registrar(SIN_CALLMEBOT, 'ajeno').run();
    const [ajeno] = await listarAvisosFallidos(env, null);

    expect(await descartarAvisoFallido(env, ajeno!.id, BARBERO)).toBe(false);
    // Y sigue ahí: el rechazo no es cosmético.
    expect(await listarAvisosFallidos(env, null)).toHaveLength(1);

    // El owner sí.
    expect(await descartarAvisoFallido(env, ajeno!.id, null)).toBe(true);
    expect(await listarAvisosFallidos(env, null)).toHaveLength(0);
  });
});
