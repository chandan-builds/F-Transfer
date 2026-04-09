const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3001;
const wss = new WebSocketServer({ port: PORT });

// State: Store rooms and connected clients
// rooms = { [roomId]: Set<clientIds> }
// clients = { [clientId]: { ws, roomId, name } }
const rooms = new Map();
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, { ws, roomId: null, name: `Peer-${clientId.substring(0,4)}` });

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

console.log(`Signaling server running on port ${PORT}`);
