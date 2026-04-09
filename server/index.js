const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const PORT = process.env.PORT || 3001;

const corsOptions = {
  origin: '*', // Your Next.js app URL
  credentials: true
};
const corsMiddleware = cors(corsOptions);

// Create an HTTP server to respond to health checks / ping
const server = http.createServer((req, res) => {
  // Apply CORS middleware
  corsMiddleware(req, res, () => {
    if (req.url === '/ping' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});

const wss = new WebSocketServer({ server });

// --- Keep-Alive Cron ---
// Render sleeps web services after 15 mins of inactivity.
// We ping our own URL randomly between 5 to 14 minutes.
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/ping`
  : `http://localhost:${PORT}/ping`;

function scheduleNextPing() {
  // Random delay between 5 and 14 minutes
  const minMs = 5 * 60 * 1000;
  const maxMs = 14 * 60 * 1000;
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

  setTimeout(() => {
    console.log(`[Cron] Hitting API: ${KEEP_ALIVE_URL} to prevent sleep...`);
    // Node.js 18+ has built-in fetch
    fetch(KEEP_ALIVE_URL)
      .then(res => console.log(`[Cron] Ping success: ${res.status}`))
      .catch(err => console.error(`[Cron] Ping failed:`, err.message))
      .finally(() => {
        scheduleNextPing();
      });
  }, delay);
}
scheduleNextPing();
// -----------------------
// State: Store rooms and connected clients
// rooms = { [roomId]: Set<clientIds> }
// clients = { [clientId]: { ws, roomId, name } }
const rooms = new Map();
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, { ws, roomId: null, name: `Peer-${clientId.substring(0, 4)}` });

  // Send the assigned clientId back to the client
  ws.send(JSON.stringify({ type: 'connected', clientId }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'join':
          handleJoin(clientId, data.roomId, data.name);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          // Relay WebRTC signaling messages directly to the target peer
          handleRelay(clientId, data);
          break;
        case 'leave':
          handleLeave(clientId);
          break;
        default:
          console.warn('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    handleLeave(clientId);
    clients.delete(clientId);
  });
});

function handleJoin(clientId, roomId, name) {
  const client = clients.get(clientId);
  if (!client) return;

  // Clean up previous room if any
  if (client.roomId) {
    handleLeave(clientId);
  }

  if (name) client.name = name;
  client.roomId = roomId;

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const roomClients = rooms.get(roomId);

  // Notify others in the room
  for (const otherClientId of roomClients) {
    const otherClient = clients.get(otherClientId);
    if (otherClient && otherClient.ws.readyState === 1) { // WebSocket.OPEN
      otherClient.ws.send(JSON.stringify({
        type: 'peer-joined',
        peerId: clientId,
        name: client.name
      }));
    }
  }

  roomClients.add(clientId);

  // Send current peers to the joining client
  const peers = Array.from(roomClients)
    .filter(id => id !== clientId)
    .map(id => ({ id, name: clients.get(id).name }));

  client.ws.send(JSON.stringify({
    type: 'room-joined',
    peers
  }));
}

function handleRelay(clientId, data) {
  const { targetId } = data;
  const targetClient = clients.get(targetId);

  if (targetClient && targetClient.ws.readyState === 1) {
    // Inject the sender's ID
    const relayData = { ...data, sourceId: clientId };
    targetClient.ws.send(JSON.stringify(relayData));
  }
}

function handleLeave(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.roomId) return;

  const roomId = client.roomId;
  const roomClients = rooms.get(roomId);

  if (roomClients) {
    roomClients.delete(clientId);

    // Notify others
    for (const otherClientId of roomClients) {
      const otherClient = clients.get(otherClientId);
      if (otherClient && otherClient.ws.readyState === 1) {
        otherClient.ws.send(JSON.stringify({
          type: 'peer-left',
          peerId: clientId
        }));
      }
    }

    // Cleanup empty rooms
    if (roomClients.size === 0) {
      rooms.delete(roomId);
    }
  }

  client.roomId = null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP and Signaling server running on port ${PORT}`);
});
