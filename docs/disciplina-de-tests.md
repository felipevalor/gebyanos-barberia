# Disciplina de tests

> La regla de oro del proyecto: **si el test pasa con el código roto, no prueba
> nada.** Este archivo existe porque ya fallamos en aplicarla tres veces, de
> tres maneras distintas.

## El chequeo fijo

**Cuando un test pasa, preguntate si podría pasar con el código borrado.**

No es una metáfora. Borrá la línea, corré el test, mirá el resultado. Si sigue
verde, el test no prueba lo que decís que prueba.

## Las tres formas en que un test verde no prueba nada

Las tres pasaron en este repo. Están acá para reconocerlas antes, no después.

### 1. El mutante que no mutaba

Se aplicó una mutación con un `replace` que **no matcheaba nada**. El archivo
quedó intacto, los tests pasaron, y se leyó como "la mutación sobrevivió".

**El falso negativo no estaba en el test: estaba en el proceso de verificación.**

*Antídoto:* después de aplicar una mutación, verificar que el archivo cambió
de verdad. En este repo el script de mutación tiene un `assert` sobre la cadena
buscada, y falla ruidosamente si no la encuentra.

### 2. El mock contra la puerta equivocada

Un test afirmaba que un error en la limpieza del cron no impedía el resto del
job. Mockeaba `env.DB.batch`... y `limpiarVencidos` usa Drizzle, que por debajo
llama a `env.DB.prepare`. **El mock no interceptaba una sola llamada.** El test
pasaba sin ejercitar nada.

Lo detectó una mutación que borraba el `try/catch` y seguía en verde.

*Antídoto:* cuando mockeás una dependencia, confirmá que el código bajo prueba
la usa. Un mock que nunca se invoca es un test que nunca corrió — si el mock
tiene forma de spy, afirmá que fue llamado.

### 3. La propiedad que el test no puede observar

Un test decía verificar que el TTL de KV sobrevive a la ventana de frescura de
24 h. **Ningún test espera 24 horas**, así que poner el TTL en 24 h no rompía
nada.

*Antídoto:* cuando la propiedad es temporal, física o externa, probá **la
llamada** en vez del efecto. Acá: el `expirationTtl` con el que se guarda,
comparado contra la ventana de frescura. Ahí vive la relación que importa.

## Corolarios que ya nos costaron un test cada uno

- **Un `expect` sobre un rango que siempre se cumple no prueba nada.**
  `expect([200, 400]).toContain(res.status)` pasa con cualquiera de los dos.
- **Un test de orden tiene que sembrar en desorden.** Si los datos ya vienen
  ordenados, borrar todos los `orderBy` no rompe nada.
- **Un test que crea su propio router no prueba el router real.** Hay que
  ejercitar el que exporta la aplicación.
- **Un fixture que no aplica migraciones esconde errores.** `test/cron.test.ts`
  venía pasando con la limpieza reventando en silencio.

## Mutantes equivalentes

A veces una mutación sobrevive y **el test no está mal**: la mutación no cambia
el comportamiento observable. Ejemplo real: sacar `sinRomper` de
`cancelarReserva` no rompía nada porque el hook real ya atrapaba sus errores.

Distinguir eso de un test faltante es la mitad del trabajo. La otra mitad es
preguntarse si se puede **volver no-equivalente**: en ese caso, inyectando un
hook sintético que lanza, la frontera pasó a tener su propio test y la mutación
empezó a romper.

Diagnosticar "es equivalente" y parar ahí es quedarse a mitad de camino.
