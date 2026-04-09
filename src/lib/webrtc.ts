// WebRTC Helper Functions for P2P connection management
export type PeerEvents = {
  onDataChannel: (peerId: string, channel: RTCDataChannel) => void;
  onConnectionStateChange: (peerId: string, state: RTCPeerConnectionState) => void;
};

// Configuration with STUN and placeholder TURN for robust ICE gathering across network boundaries
export const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:placeholder.turn.server:3478",
      username: "turnuser",
      credential: "turnpassword",
    },
  ],
};

export class WebRTCManager {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel[]> = new Map();
  private events: PeerEvents;
  private signalFunc: (data: any) => void;

  // Queue for ICE candidates received before remote description is set to prevent race conditions
  private candidateQueue: Map<string, RTCIceCandidateInit[]> = new Map();
  private isRemoteSet: Map<string, boolean> = new Map();

  constructor(signalFunc: (data: any) => void, events: PeerEvents) {
    this.signalFunc = signalFunc;
    this.events = events;
  }

  getPeerConnection(peerId: string): RTCPeerConnection | undefined {
    return this.peers.get(peerId);
  }

  getDataChannels(peerId: string): RTCDataChannel[] {
    return this.dataChannels.get(peerId) || [];
  }

  async connectToPeer(peerId: string): Promise<void> {
    if (this.peers.has(peerId)) return;

    const pc = this.createPeerConnection(peerId);

    // Create 4 parallel datachannels for high concurrency and bandwidth saturation
    for (let i = 0; i < 4; i++) {
      const dataChannel = pc.createDataChannel(`f-transfer-data-${i}`, {
        ordered: true,
        maxRetransmits: 30, // 30 retries allows TCP-lite packet recovery over dropping lines
      });
      this.setupDataChannel(peerId, dataChannel);
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signalFunc({
        type: "offer",
        targetId: peerId,
        sdp: pc.localDescription,
      });
    } catch (err) {
      console.error(`[WebRTC - ${peerId}] Error creating offer:`, err);
    }
  }

  async handleSignalingMessage(message: any) {
    const { sourceId, type, sdp, candidate } = message;

    let pc = this.peers.get(sourceId);

    if (type === "offer") {
      if (!pc) {
        pc = this.createPeerConnection(sourceId);
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        this.isRemoteSet.set(sourceId, true);
        await this.flushCandidateQueue(sourceId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signalFunc({
          type: "answer",
          targetId: sourceId,
          sdp: pc.localDescription,
        });
      } catch (err) {
        console.error(`[WebRTC - ${sourceId}] Error handling offer:`, err);
      }
    } else if (type === "answer") {
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          this.isRemoteSet.set(sourceId, true);
          await this.flushCandidateQueue(sourceId, pc);
        } catch (err) {
          console.error(`[WebRTC - ${sourceId}] Error handling answer:`, err);
        }
      }
    } else if (type === "ice-candidate") {
      if (pc && this.isRemoteSet.get(sourceId)) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error(
            `[WebRTC - ${sourceId}] Error adding ICE candidate:`,
            err
          );
        }
      } else {
        // Queue candidate to avoid StateMachine errors
        if (!this.candidateQueue.has(sourceId)) {
          this.candidateQueue.set(sourceId, []);
        }
        this.candidateQueue.get(sourceId)!.push(candidate);
      }
    }
  }

  private async flushCandidateQueue(peerId: string, pc: RTCPeerConnection) {
    const queue = this.candidateQueue.get(peerId);
    if (queue && queue.length > 0) {
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error(
            `[WebRTC - ${peerId}] Error adding queued ICE candidate:`,
            err
          );
        }
      }
      this.candidateQueue.set(peerId, []);
    }
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(rtcConfig);
    this.peers.set(peerId, pc);
    this.isRemoteSet.set(peerId, false);
    this.dataChannels.set(peerId, []);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalFunc({
          type: "ice-candidate",
          targetId: peerId,
          candidate: event.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(
        `[WebRTC - ${peerId}] ICE Connection State:`,
        pc.iceConnectionState
      );
    };

    pc.onsignalingstatechange = () => {
      console.log(
        `[WebRTC - ${peerId}] Signaling State:`,
        pc.signalingState
      );
    };

    pc.onconnectionstatechange = () => {
      console.log(
        `[WebRTC - ${peerId}] Connection State:`,
        pc.connectionState
      );
      this.events.onConnectionStateChange(peerId, pc.connectionState);
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        this.cleanupPeer(peerId);
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerId, event.channel);
    };

    return pc;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    const channels = this.dataChannels.get(peerId) || [];
    if (!channels.find((c) => c.label === channel.label)) {
      channels.push(channel);
      this.dataChannels.set(peerId, channels);
    }

    channel.onopen = () => {
      console.log(`[DataChannel - ${peerId}] Opened: ${channel.label}`);
      this.events.onDataChannel(peerId, channel);
    };

    channel.onclose = () => {
      console.log(`[DataChannel - ${peerId}] Closed: ${channel.label}`);
      const chs = this.dataChannels.get(peerId);
      if (chs) {
        this.dataChannels.set(
          peerId,
          chs.filter((c) => c.label !== channel.label)
        );
      }
    };

    channel.onerror = (error) => {
      console.error(`[DataChannel - ${peerId}] Error on ${channel.label}:`, error);
    };
  }

  cleanupPeer(peerId: string) {
    const dcs = this.dataChannels.get(peerId);
    if (dcs) {
      dcs.forEach((dc) => dc.close());
      this.dataChannels.delete(peerId);
    }
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.close();
      this.peers.delete(peerId);
    }
    this.candidateQueue.delete(peerId);
    this.isRemoteSet.delete(peerId);
  }

  disconnectAll() {
    Array.from(this.peers.keys()).forEach((peerId) => {
      this.cleanupPeer(peerId);
    });
  }
}
