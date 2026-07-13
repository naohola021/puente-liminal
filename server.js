// ─────────────────────────────────────────────────────────────
// PUENTE LIMINAL
// Servidor intermedio: conecta los dispositivos físicos (ESP32/Wemos
// en la sala) con las personas que visitan la web desde cualquier lugar.
//
// Ningún navegador habla directo con la IP local del dispositivo.
// Todos pasan por acá.
//
// Dos salas: "mascara" y "cometa". Cada una tiene:
//   - "device"  → el ESP32/Wemos físico en la galería
//   - "viewer"  → cada navegador que visita la página web
// ─────────────────────────────────────────────────────────────

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

const salas = {
  mascara: {
    devices: new Set(),
    viewers: new Set(),
    nitidezPermanente: 0,
    puestaAnterior: false,
  },
  cometa: { devices: new Set(), viewers: new Set() },
};

const PASO_NITIDEZ_PERMANENTE = 0.04;

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

  if (rol === 'viewer') {
    // Avisale a todos los devices que un viewer nuevo llegó.
    for (const d of sala.devices) {
      if (d.readyState === WebSocket.OPEN) d.send(JSON.stringify({ type: 'conexion' }));
    }
    if (obra === 'mascara') {
      ws.send(JSON.stringify({
        type: 'estado',
        puesta: false,
        movimiento: 0,
        nitidezPermanente: sala.nitidezPermanente,
      }));
    }
  }

  // ── FIX: si un DEVICE se conecta y ya había viewers activos,
  // avisale de una — antes esto solo pasaba al revés (viewer avisa a
  // devices), así que si el ESP32 se prendía o reiniciaba DESPUÉS de
  // que alguien ya tenía la web abierta, nunca se enteraba de que
  // había alguien mirando y se quedaba sin mandar datos para siempre.
  if (rol === 'device' && sala.viewers.size > 0) {
    ws.send(JSON.stringify({ type: 'conexion' }));
    log(`  → aviso retroactivo: ya había ${sala.viewers.size} viewer(s) esperando en "${obra}"`);
  }

  ws.on('message', (data) => {
    let mensajeSalida = data.toString();

    if (obra === 'mascara' && rol === 'device') {
      try {
        const contenido = JSON.parse(mensajeSalida);
        if (contenido.type === 'estado') {
          const puestaAhora = !!contenido.puesta;
          if (sala.puestaAnterior === true && puestaAhora === false) {
            sala.nitidezPermanente = Math.min(1, sala.nitidezPermanente + PASO_NITIDEZ_PERMANENTE);
            log(`Máscara: sube un escalón de nitidez permanente → ${(sala.nitidezPermanente * 100).toFixed(0)}%`);
          }
          sala.puestaAnterior = puestaAhora;
          contenido.nitidezPermanente = sala.nitidezPermanente;
          mensajeSalida = JSON.stringify(contenido);
        }
      } catch (e) {}
    }

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

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log('Puente escuchando en el puerto ' + PORT));
