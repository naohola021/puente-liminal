// ─────────────────────────────────────────────────────────────
// PUENTE LIMINAL
// Servidor intermedio: conecta los dispositivos físicos (ESP32/Wemos
// en la sala) con las personas que visitan la web desde cualquier lugar.
//
// Ningún navegador habla directo con la IP local del dispositivo.
// Todos pasan por acá — tal como lo describe tu propio Padlet en
// "Arquitectura de control".
//
// Dos salas: "mascara" y "cometa". Cada una tiene:
//   - "device"  → el ESP32/Wemos físico en la galería
//   - "viewer"  → cada navegador que visita la página web
//
// Los mensajes que manda un device se reenvían a todos los viewers
// de esa sala, y viceversa. El formato es JSON simple, por ejemplo:
//   { "type": "estado", "puesta": true, "movimiento": 0.2 }
//   { "type": "mirada", "zona": "izq" }
//   { "type": "sonido" }
//
// ═════════════════════════════════════════════════════════════
// CAMBIOS DE ESTA VERSIÓN — NITIDEZ DE SESIÓN AHORA VIVE ACÁ:
//
// Antes, cada navegador calculaba su propia "nitidezSesion" en base
// a los mensajes de puesta/movimiento que le llegaban — funcionaba,
// pero tenía dos problemas: (1) si dos personas miraban la web al
// mismo tiempo, cada una podía terminar viendo un número levemente
// distinto según cuándo se conectó, y (2) el piso permanente subía
// un escalón fijo cada vez que alguien se sacaba la máscara, sin
// importar si esa persona llegó a ver algo nítido o se la puso un
// segundo y se la sacó.
//
// Ahora el servidor es la única fuente de verdad de la nitidez de
// sesión (igual que ya lo era de la permanente), y:
//
//   1. El piso permanente SOLO sube si la sesión llegó a un mínimo
//      de nitidez visible (UMBRAL_MINIMO_PARA_APORTAR_PERMANENTE) —
//      no por el solo hecho de haberse sacado la máscara.
//   2. El aporte al piso permanente es PROPORCIONAL al pico de
//      nitidez alcanzado en esa sesión, no un escalón fijo — así la
//      máscara "se va mostrando tal como es, de a pedacitos", con
//      cada visita aportando según lo que realmente se logró.
//   3. Al sacarse la máscara, la nitidez de SESIÓN no cae a cero —
//      vuelve a un piso bajo y casi imperceptible
//      (NITIDEZ_SESION_REINICIO), para que la próxima persona no
//      vea la máscara totalmente disuelta.
// ═════════════════════════════════════════════════════════════

const http = require('http');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    'Puente LIMINAL activo.\n' +
    'Conectate en /ws?obra=mascara&rol=viewer  (o rol=device)\n' +
    'Conectate en /ws?obra=cometa&rol=viewer   (o rol=device)\n'
  );
});

const wss = new WebSocket.Server({ server, path: '/ws' });

// ─── CALIBRACIÓN DE NITIDEZ (máscara) ──────────────────────────
// Tiempo para llegar a nitidez de sesión 100% con la máscara puesta
// y siguiendo bien las luces (sin moverse) — ~25 minutos, según el
// Padlet.
const SEGUNDOS_PARA_NITIDEZ_TOTAL = 25 * 60;
const TASA_NITIDEZ_POR_SEGUNDO = 1 / SEGUNDOS_PARA_NITIDEZ_TOTAL;

// Cuánto más rápido se PIERDE nitidez de sesión si no se siguen las
// luces (movimiento = 1, el máximo), como múltiplo de la tasa a la
// que se gana quieto — así no es un número mágico aparte, escala
// junto con SEGUNDOS_PARA_NITIDEZ_TOTAL si algún día se ajusta.
const MULTIPLICADOR_PENALIZACION_MOVIMIENTO = 2.2;

// Piso al que vuelve la nitidez de SESIÓN (no la permanente) cada
// vez que se la sacan — bajo y casi imperceptible a propósito.
const NITIDEZ_SESION_REINICIO = 0.02;

// Para que una sesión aporte algo al piso PERMANENTE, tiene que
// haber llegado a mostrarse "algo nítida" — no alcanza con
// ponérsela un segundo y sacársela enseguida.
const UMBRAL_MINIMO_PARA_APORTAR_PERMANENTE = 0.15;

// Qué proporción del PICO alcanzado en una sesión se vuelve piso
// permanente. Deliberadamente chico: hacen falta muchas visitas
// acumuladas, cada una aportando su pedacito, para que la máscara
// quede nítida para siempre — igual que describe el Padlet.
const FACTOR_APORTE_A_PERMANENTE = 0.05;

// Estado de cada sala: quién está conectado.
// La máscara además guarda "nitidezPermanente" (el piso que nunca
// baja) y "nitidezSesion" (la nitidez de la sesión física actual,
// que sí sube y baja, y se reinicia — a un piso bajo, no a cero —
// cada vez que se la sacan). Viven acá, en el servidor, y no en
// cada navegador, porque son propiedades del objeto físico — todos
// los visitantes tienen que ver exactamente el mismo estado.
const salas = {
  mascara: {
    devices: new Set(),
    viewers: new Set(),
    nitidezPermanente: 0,
    nitidezSesion: 0,
    picoNitidezSesion: 0,      // el máximo que llegó a alcanzar la sesión actual
    puestaAnterior: false,
    ultimoTiempoEstado: null,  // Date.now() del último "estado" recibido, para calcular dt real
  },
  cometa: { devices: new Set(), viewers: new Set() },
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const obra = url.searchParams.get('obra');
  const rol = url.searchParams.get('rol'); // 'device' o 'viewer'

  if (!salas[obra] || (rol !== 'device' && rol !== 'viewer')) {
    ws.close(1008, 'Parámetros obra/rol inválidos');
    return;
  }

  const sala = salas[obra];
  const propioGrupo = rol === 'device' ? sala.devices : sala.viewers;
  const otroGrupo = rol === 'device' ? sala.viewers : sala.devices;

  propioGrupo.add(ws);
  log(`+ ${rol} conectado a "${obra}" — devices:${sala.devices.size} viewers:${sala.viewers.size}`);

  // Si se conecta un viewer nuevo, el dispositivo físico se entera
  // (esto reemplaza el viejo /conexion que llamaba directo por IP)
  if (rol === 'viewer') {
    for (const d of sala.devices) {
      if (d.readyState === WebSocket.OPEN) d.send(JSON.stringify({ type: 'conexion' }));
    }
    // A un viewer que recién llega de la máscara le mandamos de una
    // el nivel de nitidez actual (permanente Y de sesión), para que
    // no vea el filtro "más limpio" o "más disperso" de lo que
    // realmente está en ese momento.
    if (obra === 'mascara') {
      ws.send(JSON.stringify({
        type: 'estado',
        puesta: false,
        movimiento: 0,
        nitidezPermanente: sala.nitidezPermanente,
        nitidezSesion: sala.nitidezSesion,
      }));
    }
  }

  ws.on('message', (data) => {
    let mensajeSalida = data.toString();

    // Solo la máscara tiene esta memoria de nitidez. Cuando el
    // dispositivo físico avisa su estado, actualizamos la nitidez
    // de sesión en tiempo real, y revisamos si justo pasó de
    // "puesta" a "no puesta" — ese es el momento de decidir si esta
    // sesión aporta (y cuánto) al piso permanente.
    if (obra === 'mascara' && rol === 'device') {
      try {
        const contenido = JSON.parse(mensajeSalida);
        if (contenido.type === 'estado') {
          const ahora = Date.now();
          const dt = sala.ultimoTiempoEstado ? (ahora - sala.ultimoTiempoEstado) / 1000 : 0;
          sala.ultimoTiempoEstado = ahora;

          const puestaAhora = !!contenido.puesta;

          // dt < 5s descarta saltos raros (reconexión del device tras
          // un rato desconectado, primer mensaje después de un
          // arranque, etc.) — ese intervalo simplemente no cuenta
          // para la nitidez, no se compensa de golpe.
          if (puestaAhora && dt > 0 && dt < 5) {
            // El firmware ya manda "movimiento" normalizado 0-1 —
            // sin la vieja escala /20000 de cuando el ESP32 mandaba
            // la magnitud cruda del acelerómetro.
            const movimiento = Math.min(1, Math.max(0, contenido.movimiento || 0));
            sala.nitidezSesion += TASA_NITIDEZ_POR_SEGUNDO * (1 - movimiento) * dt;
            sala.nitidezSesion -= TASA_NITIDEZ_POR_SEGUNDO * MULTIPLICADOR_PENALIZACION_MOVIMIENTO * movimiento * dt;
            sala.nitidezSesion = Math.max(0, Math.min(1, sala.nitidezSesion));
            sala.picoNitidezSesion = Math.max(sala.picoNitidezSesion, sala.nitidezSesion);
          }

          if (sala.puestaAnterior === true && puestaAhora === false) {
            // Se la acaban de sacar: solo si esta sesión llegó a
            // verse "algo nítida" (pasó el umbral mínimo), un
            // pedacito proporcional a lo que alcanzó queda para
            // siempre en el piso permanente.
            if (sala.picoNitidezSesion >= UMBRAL_MINIMO_PARA_APORTAR_PERMANENTE) {
              const aporte = sala.picoNitidezSesion * FACTOR_APORTE_A_PERMANENTE;
              sala.nitidezPermanente = Math.min(1, sala.nitidezPermanente + aporte);
              log(`Máscara: sesión con pico ${(sala.picoNitidezSesion * 100).toFixed(0)}% aportó ${(aporte * 100).toFixed(1)}% al piso permanente → ${(sala.nitidezPermanente * 100).toFixed(0)}%`);
            } else {
              log(`Máscara: sesión terminó con pico ${(sala.picoNitidezSesion * 100).toFixed(0)}% — no llegó al mínimo (${(UMBRAL_MINIMO_PARA_APORTAR_PERMANENTE * 100).toFixed(0)}%) para aportar al piso permanente`);
            }
            sala.nitidezSesion = NITIDEZ_SESION_REINICIO;
            sala.picoNitidezSesion = 0;
          }

          sala.puestaAnterior = puestaAhora;
          contenido.nitidezPermanente = sala.nitidezPermanente;
          contenido.nitidezSesion = sala.nitidezSesion;
          mensajeSalida = JSON.stringify(contenido);
        }
      } catch (e) {
        // si el JSON viene mal formado lo dejamos pasar tal cual
      }
    }

    // Reenvía el mensaje (ya con la nitidez incluida, si aplica)
    // al otro grupo de la misma sala
    for (const cliente of otroGrupo) {
      if (cliente.readyState === WebSocket.OPEN) cliente.send(mensajeSalida);
    }
  });

  ws.on('close', () => {
    propioGrupo.delete(ws);
    log(`- ${rol} desconectado de "${obra}" — devices:${sala.devices.size} viewers:${sala.viewers.size}`);
    if (rol === 'viewer') {
      for (const d of sala.devices) {
        if (d.readyState === WebSocket.OPEN) d.send(JSON.stringify({ type: 'desconexion' }));
      }
    }
  });

  ws.on('error', () => {}); // evita que un error tumbe el proceso
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log('Puente escuchando en el puerto ' + PORT));
