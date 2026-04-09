// WebRTC Helper Functions for P2P connection management
export type PeerEvents = {
  onDataChannel: (peerId: string, channel: RTCDataChannel) => void;
  onConnectionStateChange: (peerId: string, state: RTCPeerConnectionState) => void;
};

// Configuration for LAN/Wifi explicitly - no STUN/TURN servers to guarantee local transfer
export const rtcConfig: RTCConfiguration = {
  iceServers: [] 
};

export class WebRTCManager {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private events: PeerEvents;
  private signalFunc: (data: any) => void;

  constructor(signalFunc: (data: any) => void, events: PeerEvents) {
    this.signalFunc = signalFunc;
    this.events = events;
  }

  // Called when we want to originate a connection to another peer
  async connectToPeer(peerId: string): Promise<void> {
    if (this.peers.has(peerId)) return;

    const pc = this.createPeerConnection(peerId);
    
    // Create reliable data channel for file transfer
    const dataChannel = pc.createDataChannel('f-transfer-data', {
      ordered: true,
      maxRetransmits: undefined, // undefined = reliable
    });
    
    this.setupDataChannel(peerId, dataChannel);

    // Create and send offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signalFunc({
        type: 'offer',
        targetId: peerId,
        sdp: pc.localDescription
      });
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  }

  // Handle incoming signaling messages
  async handleSignalingMessage(message: any) {
    const { sourceId, type, sdp, candidate } = message;

    let pc = this.peers.get(sourceId);

    if (type === 'offer') {
      if (!pc) {
        pc = this.createPeerConnection(sourceId);
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signalFunc({
          type: 'answer',
          targetId: sourceId,
          sdp: pc.localDescription
        });
      } catch (err) {
        console.error('Error handling offer:', err);
      }
    } else if (type === 'answer') {
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (err) {
          console.error('Error handling answer:', err);
        }
      }
    } else if (type === 'ice-candidate') {
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Error adding ICE candidate:', err);
        }
      }
    }
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(rtcConfig);
    this.peers.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalFunc({
          type: 'ice-candidate',
          targetId: peerId,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      this.events.onConnectionStateChange(peerId, pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.cleanupPeer(peerId);
      }
    };

    // Listen for incoming data channels (when we're the receiver / Answerer side)
    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerId, event.channel);
    };

    return pc;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    this.dataChannels.set(peerId, channel);

    channel.onopen = () => {
      this.events.onDataChannel(peerId, channel);
    };

    channel.onclose = () => {
      this.dataChannels.delete(peerId);
    };
  }

  cleanupPeer(peerId: string) {
    const dc = this.dataChannels.get(peerId);
    if (dc) {
      dc.close();
      this.dataChannels.delete(peerId);
    }
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.close();
      this.peers.delete(peerId);
    }
  }

  disconnectAll() {
    Array.from(this.peers.keys()).forEach(peerId => {
      this.cleanupPeer(peerId);
    });
  }
}
