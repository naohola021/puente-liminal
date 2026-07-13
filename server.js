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
//
// ── CAMBIO DE ESTA VERSIÓN ──────────────────────────────────
// Para "cometa": antes cada mensaje {"type":"sonido"} de un viewer se
// reenviaba tal cual, uno por uno, sin que el ESP32 supiera cuánta
// gente estaba interactuando al mismo tiempo. Ahora el puente lleva la
// cuenta de qué viewers mandaron sonido recientemente (últimos 900ms)
// y le manda al device un solo mensaje agregado:
//   {"type":"sonido", "nivel": <el más alto entre los activos>, "usuarios": <cuántos activos>}
// Así el ESP32 puede hacer que la vibración sea más fuerte cuanto más
// volumen Y cuanta más gente esté mandando sonido a la vez.
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
  cometa: {
    devices: new Set(),
    viewers: new Set(),
    // ws del viewer → { nivel, ultimo (timestamp del último "sonido" que mandó) }
    sonidoActivos: new Map(),
  },
};

const PASO_NITIDEZ_PERMANENTE = 0.04;

// Cuánto tiempo (ms) sigue "contando" un viewer como activo después de
// su último mensaje de sonido. Si no manda nada en ese lapso, deja de
// sumar a la cuenta de "usuarios".
const VENTANA_SONIDO_MS = 900;

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

    if (obra === 'cometa' && rol === 'viewer') {
      try {
        const contenido = JSON.parse(mensajeSalida);
        if (contenido.type === 'sonido') {
          const nivel = typeof contenido.nivel === 'number'
            ? Math.max(0, Math.min(1, contenido.nivel))
            : 0.4;

          sala.sonidoActivos.set(ws, { nivel, ultimo: Date.now() });

          // Descarta a los que ya no mandaron sonido en la ventana —
          // así "usuarios" refleja gente activa AHORA, no todo el
          // historial de gente que alguna vez pasó por la web.
          const ahora = Date.now();
          for (const [cliente, info] of sala.sonidoActivos) {
            if (ahora - info.ultimo > VENTANA_SONIDO_MS) sala.sonidoActivos.delete(cliente);
          }

          let nivelMax = 0;
          for (const info of sala.sonidoActivos.values()) {
            nivelMax = Math.max(nivelMax, info.nivel);
          }

          mensajeSalida = JSON.stringify({
            type: 'sonido',
            nivel: nivelMax,
            usuarios: sala.sonidoActivos.size,
          });
        }
      } catch (e) {}
    }

    for (const cliente of otroGrupo) {
      if (cliente.readyState === WebSocket.OPEN) cliente.send(mensajeSalida);
    }
  });

  ws.on('close', () => {
    propioGrupo.delete(ws);
    if (obra === 'cometa' && rol === 'viewer') {
      sala.sonidoActivos.delete(ws);
    }
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
