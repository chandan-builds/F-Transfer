type SignalingEvents = {
  onConnected: (clientId: string) => void;
  onRoomJoined: (peers: {id: string, name: string}[]) => void;
  onPeerJoined: (peerId: string, name: string) => void;
  onPeerLeft: (peerId: string) => void;
  onMessage: (message: any) => void;
};

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private events: SignalingEvents;
  private isConnecting: boolean = false;
  
  constructor(url: string, events: SignalingEvents) {
    this.url = url;
    this.events = events;
  }

  connect() {
    if (this.ws || this.isConnecting) return;
    this.isConnecting = true;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnecting = false;
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'connected':
            this.events.onConnected(data.clientId);
            break;
          case 'room-joined':
            this.events.onRoomJoined(data.peers);
            break;
          case 'peer-joined':
            this.events.onPeerJoined(data.peerId, data.name);
            break;
          case 'peer-left':
            this.events.onPeerLeft(data.peerId);
            break;
          case 'offer':
          case 'answer':
          case 'ice-candidate':
            this.events.onMessage(data);
            break;
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        this.isConnecting = false;
      };

      this.ws.onclose = () => {
        this.ws = null;
        this.isConnecting = false;
        // Optionally implement reconnect logic here
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      this.isConnecting = false;
    }
  }

  join(roomId: string, name: string) {
    this.send({ type: 'join', roomId, name });
  }

  send(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
