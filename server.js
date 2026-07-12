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
//   { "type": "estado", "puesta": true, "movimiento": 1234 }
//   { "type": "mirada", "zona": "izq" }
//   { "type": "sonido" }
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

// Estado de cada sala: quién está conectado.
// La máscara además guarda "nitidezPermanente": el escalón de nitidez
// que sube cada vez que alguien se la quita y que nunca vuelve a bajar.
// Vive acá, en el servidor, y no en cada navegador, porque es una
// propiedad del objeto físico — todos los visitantes tienen que ver
// el mismo desgaste acumulado, no cada uno el suyo.
const salas = {
  mascara: {
    devices: new Set(),
    viewers: new Set(),
    nitidezPermanente: 0,
    puestaAnterior: false,
  },
  cometa: { devices: new Set(), viewers: new Set() },
};

const PASO_NITIDEZ_PERMANENTE = 0.04; // qué tanto sube cada vez que se la quitan

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
    // el nivel de nitidez permanente actual, para que no vea el filtro
    // "más limpio" de lo que en realidad ya está desgastado.
    if (obra === 'mascara') {
      ws.send(JSON.stringify({
        type: 'estado',
        puesta: false,
        movimiento: 0,
        nitidezPermanente: sala.nitidezPermanente,
      }));
    }
  }

  ws.on('message', (data) => {
    let mensajeSalida = data.toString();

    // Solo la máscara tiene esta memoria permanente. Cuando el
    // dispositivo físico avisa su estado, revisamos si justo pasó
    // de "puesta" a "no puesta" — ese es el momento en que sube
    // un escalón que ya nunca vuelve a bajar.
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
      } catch (e) {
        // si el JSON viene mal formado lo dejamos pasar tal cual
      }
    }

    // Reenvía el mensaje (ya con la nitidez permanente incluida, si aplica)
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
