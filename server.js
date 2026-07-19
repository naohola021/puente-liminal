// ───────────────────────────────────────────────────────────
// PUENTE LIMINAL
// Servidor intermedio: conecta los dispositivos físicos (ESP32/Wemos
// en la sala) con las personas que visitan la web desde cualquier lugar.
//
// Ningún navegador habla directamente con la IP local del dispositivo.
// Todos pasan por aquí.
//
// Dos salas: "mascara" y "cometa". Cada una tiene:
// - "device" → el ESP32/Wemos físico en la galería
// - "visor" → cada navegador que visita la página web
//
// ── CAMBIO DE ESTA VERSIÓN ──────────────────────────────────
// Para "cometa": antes de cada mensaje {"type":"sonido"} de un espectador se
// reenviaba tal cual, uno por uno, sin que el ESP32 supiera cantidad
// gente estaba interactuando al mismo tiempo. Ahora el puente lleva la
// cuenta de qué espectadores mandaron sonido recientemente (últimos 900ms)
// y le manda al dispositivo un solo mensaje agregado:
// {"type":"sonido", "nivel": <el más alto entre los activos>, "usuarios": <cuántos activos>}
// Así el ESP32 puede hacer que la vibración sea más fuerte cuanto más
// volumen Y cuanta más gente esté mandando sonido a la vez.
// ───────────────────────────────────────────────────────────

const http = require('http');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    'Puente LIMINAL activo.\n' +
    'Conectate en /ws?obra=mascara&rol=viewer (o rol=dispositivo)\n' +
    'Conectar en /ws?obra=cometa&rol=viewer (o rol=dispositivo)\n'
  );
});

const wss = new WebSocket.Server({ server, path: '/ws' });

const salas = {
  máscara de pestañas: {
    dispositivos: nuevo Set(),
    espectadores: nuevo Set(),
    nitidezPermanente: 0,
    puestaAnterior: falso,
  },
  cometa: {
    dispositivos: nuevo Set(),
    espectadores: nuevo Set(),
    // ws del espectador → { nivel, ultimo (timestamp del último "sonido" que mandó) }
    sonidoActivos: nuevo Mapa(),
  },
};

const PASO_NITIDEZ_PERMANENTE = 0.04;

// Cuánto tiempo (ms) sigue "contando" un espectador como activo después de
// su último mensaje de sonido. Si no manda nada en ese lapso, deja de
// sumar a la cuenta de "usuarios".
constante VENTANA_SONIDO_MS = 900;

función log(...args) {
  console.log(new Date().toISOString(), ...args);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const obra = url.searchParams.get('obra');
  const rol = url.searchParams.get('rol'); // 'dispositivo' o 'visor'

  if (!salas[obra] || (rol !== 'dispositivo' && rol !== 'visor')) {
    ws.close(1008, 'Parámetros obra/rol inválidos');
    devolver;
  }

  const sala = salas[obra];
  const propioGrupo = rol === 'dispositivo' ? sala.dispositivos: sala.espectadores;
  const otroGrupo = rol === 'dispositivo' ? sala.espectadores: sala.dispositivos;

  propioGrupo.add(ws);
  log(`+ ${rol} conectado a "${obra}" — devices:${sala.devices.size} viewers:${sala.viewers.size}`);

  si (rol === 'viewer') {
    para (const d de sala.devices) {
      if (d.readyState === WebSocket.OPEN) d.send(JSON.stringify({ type: 'conexion' }));
    }
    si (obra === 'máscara') {
      ws.send(JSON.stringify({
        tipo: 'estado',
        puesta: false,
        movimiento: 0,
        nitidezPermanente: sala.nitidezPermanente,
      }));
    }
  }

  si (rol === 'device' && sala.viewers.size > 0) {
    ws.send(JSON.stringify({ type: 'conexion' }));
    log(` → aviso retroactivo: ya había ${sala.viewers.size} espectadores esperando en "${obra}"`);
  }

  ws.on('mensaje', (datos) => {
    let mensajeSalida = data.toString();

    if (obra === 'mascara' && rol === 'dispositivo') {
      intentar {
        const contenido = JSON.parse(mensajeSalida);
        if (contenido.type === 'estado') {
          const puestaAhora = !!contenido.puesta;
          if (sala.puestaAnterior === true && puestaAhora === false) {
            sala.nitidezPermanente = Math.min(1, sala.nitidezPermanente + PASO_NITIDEZ_PERMANENTE);
            log(`Máscara: sube un escalón de nitidez permanente → ${(sala.nitidezPermanente * 100).toFixed(0)}%`);
          }
          sala.puestaAnterior = PuestaAhora;
          contenido.nitidezPermanente = sala.nitidezPermanente;
          mensajeSalida = JSON.stringify(contenido);
        }
      } capturar (e) {}
    }

    if (obra === 'cometa' && rol === 'espectador') {
      intentar {
        const contenido = JSON.parse(mensajeSalida);
        if (contenido.type === 'sonido') {
          const nivel = tipo de contenido.nivel === 'número'
            ? Math.max(0, Math.min(1, contenido.nivel))
            : 0,4;

          sala.sonidoActivos.set(ws, { nivel, último: Date.now() });

          // Descarte a los que ya no mandaron sonido en la ventana —
          // así "usuarios" refleja gente activa AHORA, no todo el
          // historial de gente que alguna vez pasó por la web.
          const ahora = Date.now();
          for (const [cliente, info] de sala.sonidoActivos) {
            if (ahora - info.ultimo > VENTANA_SONIDO_MS) sala.sonidoActivos.delete(cliente);
          }

          sea ​​nivelMax = 0;
          for (información constante de sala.sonidoActivos.values()) {
            nivelMax = Math.max(nivelMax, info.nivel);
          }

          mensajeSalida = JSON.stringify({
            tipo: 'sonido',
            nivel: nivelMax,
            usuarios: sala.sonidoActivos.size,
          });
        }
      } capturar (e) {}
    }

    for (cliente constante de otroGrupo) {
      if (cliente.readyState === WebSocket.OPEN) cliente.send(mensajeSalida);
    }
  });

  ws.on('close', () => {
    propioGrupo.eliminar(ws);
    if (obra === 'cometa' && rol === 'espectador') {
      sala.sonidoActivos.delete(ws);
    }
    log(`- ${rol} desconectado de "${obra}" — dispositivos:${sala.devices.size} espectadores:${sala.viewers.size}`);
    si (rol === 'viewer') {
      para (const d de sala.devices) {
        if (d.readyState === WebSocket.OPEN) d.send(JSON.stringify({ type: 'desconexion' }));
      }
    }
  });

  ws.on('error', () => {});
});

const PUERTO = proceso.env.PUERTO || 3000;
server.listen(PORT, () => log('Puente escuchando en el puerto ' + PORT));
