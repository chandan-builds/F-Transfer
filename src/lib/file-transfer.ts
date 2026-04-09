// file-transfer.ts

export type SpeedProgressCallback = (fileId: string, bytesTransferred: number, speedBps: number) => void;
export type CompleteCallback = (fileId: string, fileBlob: Blob, metadata: TransferMetadata) => void;
export type ErrorCallback = (fileId: string, error: string) => void;

export type TransferMetadata = {
  fileId: string;
  name: string;
  size: number;
  type: string;
  hash: string;
  totalChunks?: number;
};

export class TransferController {
  paused = false;
  cancelled = false;
  private _resumeResolver: (() => void) | null = null;

  pause() {
    this.paused = true;
  }
  
  resume() {
    this.paused = false;
    if (this._resumeResolver) {
      this._resumeResolver();
      this._resumeResolver = null;
    }
  }
  
  cancel() {
    this.cancelled = true;
    this.resume();
  }
  
  waitForResume(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => {
      this._resumeResolver = resolve;
    });
  }
}

class SpeedTracker {
  private lastTime = performance.now();
  private totalBytes = 0;
  private currentSpeed = 0;

  addBytes(bytes: number) {
    this.totalBytes += bytes;
    const now = performance.now();
    const dt = now - this.lastTime;
    if (dt >= 250) {
      this.currentSpeed = Math.max(0, this.totalBytes / (dt / 1000));
      this.lastTime = now;
      this.totalBytes = 0;
    }
  }

  getBps() {
    return this.currentSpeed;
  }
}

class ReceiverTransfer {
  metadata: TransferMetadata;
  blobParts: BlobPart[] = [];
  receivedChunks = new Map<number, { offset: number; data: Uint8Array }>();
  nextOffsetToMerge = 0;
  highestContiguous = -1;
  maxReceivedSeq = -1;
  missing = new Set<number>();

  speedTracker = new SpeedTracker();

  constructor(metadata: TransferMetadata) {
    this.metadata = metadata;
  }

  addChunk(seq: number, offset: number, data: Uint8Array) {
    if (this.receivedChunks.has(seq) || seq <= this.highestContiguous) return;

    this.receivedChunks.set(seq, { offset, data });

    if (seq > this.maxReceivedSeq) {
      for (let i = this.maxReceivedSeq + 1; i < seq; i++) {
        this.missing.add(i);
      }
      this.maxReceivedSeq = seq;
    }
    this.missing.delete(seq);

    while (this.receivedChunks.has(this.highestContiguous + 1)) {
      const nextSeq = this.highestContiguous + 1;
      const chunk = this.receivedChunks.get(nextSeq)!;

      if (chunk.offset === this.nextOffsetToMerge) {
        this.blobParts.push(chunk.data as unknown as BlobPart);
        this.nextOffsetToMerge += chunk.data.byteLength;
        this.highestContiguous = nextSeq;
        this.receivedChunks.delete(nextSeq);

        // Progressive Assembly: Merge blobs periodically to prevent array overflow limits
        if (this.blobParts.length > 500) {
          this.blobParts = [new Blob(this.blobParts as unknown as BlobPart[])];
        }
      } else {
        break;
      }
    }
  }
}

class SendScheduler {
  file: File;
  fileId: string;
  channels: RTCDataChannel[];
  pc?: RTCPeerConnection;
  ctrl: TransferController;
  onSendProgress: SpeedProgressCallback;
  speedTracker = new SpeedTracker();

  nextOffset = 0;
  nextSeq = 0;

  unackedSeqs = new Map<number, { offset: number; size: number; timestamp: number }>();
  missingSeqs = new Set<number>();
  highestAckedSeq = -1;

  currentChunkSize = 64 * 1024; // 64KB initial
  lastStatsTime = 0;
  rtt = 0;
  packetLoss = 0;

  headerAckResolver: (() => void) | null = null;

  constructor(
    file: File,
    fileId: string,
    channels: RTCDataChannel[],
    pc: RTCPeerConnection | undefined,
    ctrl: TransferController,
    onSendProgress: SpeedProgressCallback
  ) {
    this.file = file;
    this.fileId = fileId;
    this.channels = channels;
    this.pc = pc;
    this.ctrl = ctrl;
    this.onSendProgress = onSendProgress;
  }

  handleAck(highestContiguous: number, missing: number[]) {
    this.highestAckedSeq = Math.max(this.highestAckedSeq, highestContiguous);
    // Clear all unacked <= highestContiguous
    for (const seq of this.unackedSeqs.keys()) {
      if (seq <= highestContiguous) {
        this.unackedSeqs.delete(seq);
      }
    }

    for (const missingSeq of missing) {
      if (this.unackedSeqs.has(missingSeq)) {
        this.missingSeqs.add(missingSeq);
      }
    }
  }

  async getAvailableChannel(seq: number): Promise<RTCDataChannel> {
    let channel = this.channels[seq % this.channels.length];
    if (channel.readyState !== "open") {
      channel = this.channels.find((c) => c.readyState === "open") || channel;
    }

    // Per-channel backpressure control - 256KB to avoid bufferbloat dropping ICE heartbeats
    if (channel.bufferedAmount > 256 * 1024) {
      await new Promise<void>((resolve, reject) => {
        const handler = () => {
          cleanup();
          resolve();
        };
        const closeHandler = () => {
          cleanup();
          reject(new Error("Channel closed while buffering"));
        };
        const errorHandler = () => {
          cleanup();
          reject(new Error("Channel error while buffering"));
        };

        const cleanup = () => {
          channel.removeEventListener("bufferedamountlow", handler);
          channel.removeEventListener("close", closeHandler);
          channel.removeEventListener("error", errorHandler);
        };

        channel.addEventListener("bufferedamountlow", handler);
        channel.addEventListener("close", closeHandler);
        channel.addEventListener("error", errorHandler);
      });
    }
    return channel;
  }

  async pollStats() {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let totalLoss = 0;
      let totalSent = 0;
      stats.forEach((r) => {
        if (
          r.type === "remote-inbound-rtp" ||
          (r.type === "candidate-pair" && r.state === "succeeded")
        ) {
          if (r.currentRoundTripTime) this.rtt = r.currentRoundTripTime * 1000;
          if (r.packetsLost !== undefined) totalLoss = r.packetsLost;
          if (r.packetsSent !== undefined) totalSent = r.packetsSent;
        }
      });
      if (totalSent > 0) this.packetLoss = totalLoss / totalSent;

      // Dynamically adjusting chunk size (32KB to 128KB)
      if (this.rtt > 150 || this.packetLoss > 0.02) {
        this.currentChunkSize = Math.max(32 * 1024, this.currentChunkSize / 2);
      } else if (this.rtt < 50 && this.packetLoss < 0.01) {
        this.currentChunkSize = Math.min(128 * 1024, this.currentChunkSize + 16 * 1024);
      }
    } catch (e) {}
  }

  async run() {
    const idBytes = new TextEncoder().encode(this.fileId);
    const idLen = idBytes.length;

    while (this.nextOffset < this.file.size || this.unackedSeqs.size > 0) {
      if (this.ctrl.cancelled) throw new Error("Transfer cancelled");
      if (this.ctrl.paused) {
        await this.ctrl.waitForResume();
        if (this.ctrl.cancelled) throw new Error("Transfer cancelled");
      }

      const now = performance.now();
      if (now - this.lastStatsTime > 1000) {
        this.pollStats();
        this.lastStatsTime = now;
      }

      let seqToSend = -1;
      let offsetToSend = -1;
      let sizeToSend = -1;

      // Check for retransmissions based on explicit missing ACKs or timeout
      for (const [seq, info] of this.unackedSeqs.entries()) {
        const isTimeout = now - info.timestamp > (this.rtt ? this.rtt * 4 + 500 : 2000);
        if (this.missingSeqs.has(seq) || isTimeout) {
          seqToSend = seq;
          offsetToSend = info.offset;
          sizeToSend = info.size;
          this.missingSeqs.delete(seq);
          info.timestamp = now;
          break; // send one retransmission at a time
        }
      }

      // If no retransmission, send novel chunks
      if (seqToSend === -1 && this.nextOffset < this.file.size) {
        seqToSend = this.nextSeq++;
        offsetToSend = this.nextOffset;
        sizeToSend = Math.min(this.currentChunkSize, this.file.size - this.nextOffset);
        this.nextOffset += sizeToSend;

        this.unackedSeqs.set(seqToSend, {
          offset: offsetToSend,
          size: sizeToSend,
          timestamp: now,
        });
      }

      if (seqToSend === -1) {
        // waiting for ACKs
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      const channel = await this.getAvailableChannel(seqToSend);
      if (channel.readyState !== "open") {
        throw new Error("Channel closed");
      }

      // Zero-copy streaming simulation via File.slice 
      // Memory efficient, random accessible slice wrapper avoiding monolithic ArrayBuffer limits
      const slice = this.file.slice(offsetToSend, offsetToSend + sizeToSend);
      const buffer = await slice.arrayBuffer();

      const payload = new Uint8Array(1 + 2 + idLen + 8 + 4 + 4 + buffer.byteLength);
      const dv = new DataView(payload.buffer);
      dv.setUint8(0, 0); // Type 0 = Data
      dv.setUint16(1, idLen);
      payload.set(idBytes, 3);
      let cur = 3 + idLen;
      dv.setFloat64(cur, offsetToSend);
      cur += 8;
      dv.setUint32(cur, seqToSend);
      cur += 4;
      dv.setUint32(cur, sizeToSend);
      cur += 4;
      payload.set(new Uint8Array(buffer), cur);

      channel.send(payload);

      this.speedTracker.addBytes(sizeToSend);

      if (seqToSend % 32 === 0 || this.nextOffset === this.file.size) {
        this.onSendProgress(this.fileId, this.nextOffset, this.speedTracker.getBps());
      }
    }
  }
}

export class FileTransferManager {
  private peerChannels = new Map<string, RTCDataChannel[]>();
  private webrtcManager?: any; // Avoiding cyclic ref with WebRTCManager directly

  private inProgressReceives = new Map<string, ReceiverTransfer>();
  private completedReceives = new Set<string>();
  private activeSends = new Map<string, SendScheduler>();
  activeControllers = new Map<string, TransferController>();

  constructor(
    private onProgress: SpeedProgressCallback,
    private onComplete: CompleteCallback,
    private onError: ErrorCallback,
    private onReceiveHeader: (metadata: TransferMetadata) => void
  ) {}

  setWebRTCManager(manager: any) {
    this.webrtcManager = manager;
  }

  registerChannel(peerId: string, channel: RTCDataChannel) {
    let channels = this.peerChannels.get(peerId);
    if (!channels) {
      channels = [];
      this.peerChannels.set(peerId, channels);
    }
    if (!channels.find((c) => c.label === channel.label)) {
      channels.push(channel);
      channel.bufferedAmountLowThreshold = 64 * 1024; // 64KB threshold per channel

      channel.addEventListener("message", (e) => {
        this.handleIncomingData(e.data, channel, peerId);
      });
      console.log(`[FTM] Registered channel ${channel.label} for peer ${peerId}`);
    }
  }

  async sendFile(
    file: File,
    peerId: string,
    onSendProgress: SpeedProgressCallback,
    controller?: TransferController,
    providedFileId?: string
  ): Promise<void> {
    const channels = this.peerChannels.get(peerId) || [];
    if (channels.length === 0) throw new Error("No DataChannels available for " + peerId);

    const fileId = providedFileId || `${file.name}-${Date.now()}`;
    const ctrl = controller ?? new TransferController();
    this.activeControllers.set(fileId, ctrl);

    // Initial SHA-256 (optional simulation or real for production, skipping for ultra-fast but kept in structure)
    const metadata: TransferMetadata = {
      fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      totalChunks: Math.ceil(file.size / (64 * 1024)), 
      hash: "",
    };

    // Send header (JSON)
    const headerMsg = JSON.stringify({ type: "header", metadata });
    channels[0].send(headerMsg);

    const pc = this.webrtcManager?.getPeerConnection(peerId);
    const state = new SendScheduler(file, fileId, channels, pc, ctrl, onSendProgress);
    this.activeSends.set(fileId, state);

    // Wait for header ack
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Header ACK timeout")), 10000);
      state.headerAckResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
    });

    try {
      await state.run();
      channels[0].send(JSON.stringify({ type: "done", fileId }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      channels[0].send(JSON.stringify({ type: "error", fileId, message: errMsg }));
      throw err;
    } finally {
      this.activeSends.delete(fileId);
      this.activeControllers.delete(fileId);
    }
  }

  async handleIncomingData(data: string | ArrayBuffer, channel: RTCDataChannel, peerId: string) {
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "header") {
          const rx = new ReceiverTransfer(msg.metadata);
          this.inProgressReceives.set(msg.metadata.fileId, rx);
          this.onReceiveHeader(msg.metadata);
          channel.send(JSON.stringify({ type: "header-ack", fileId: msg.metadata.fileId }));
        } else if (msg.type === "header-ack") {
          const state = this.activeSends.get(msg.fileId);
          if (state && state.headerAckResolver) {
            state.headerAckResolver();
            state.headerAckResolver = null;
          }
        } else if (msg.type === "cumulative-ack") {
          const state = this.activeSends.get(msg.fileId);
          if (state) state.handleAck(msg.highestSeq, msg.missing);
        } else if (msg.type === "cancel" || msg.type === "error") {
          this.inProgressReceives.delete(msg.fileId);
          if (msg.type === "error") this.onError(msg.fileId, msg.message || "Remote side encountered an error");
        } else if (msg.type === "done") {
             // Redundant clear since nextOffsetToMerge checks should hit before this
             await this.finalizeTransfer(msg.fileId);
        }
      } catch (e) {}
    } else if (data instanceof ArrayBuffer) {
      const payload = new Uint8Array(data);
      if (payload.length < 1) return;
      const dv = new DataView(payload.buffer);
      const type = dv.getUint8(0);

      if (type === 0) {
        const idLen = dv.getUint16(1);
        const fileId = new TextDecoder().decode(payload.slice(3, 3 + idLen));
        let cur = 3 + idLen;
        const offset = dv.getFloat64(cur);
        cur += 8;
        const seq = dv.getUint32(cur);
        cur += 4;
        const sizeToSend = dv.getUint32(cur);
        cur += 4;
        const chunkData = payload.slice(cur, cur + sizeToSend);

        const rx = this.inProgressReceives.get(fileId);
        if (!rx) {
          if (this.completedReceives.has(fileId)) {
            channel.send(
              JSON.stringify({
                type: "cumulative-ack",
                fileId,
                highestSeq: seq,
                missing: [],
              })
            );
          }
          return;
        }

        rx.addChunk(seq, offset, chunkData);
        rx.speedTracker.addBytes(sizeToSend);

        if (seq % 32 === 0 || rx.nextOffsetToMerge === rx.metadata.size) {
          this.onProgress(fileId, rx.nextOffsetToMerge, rx.speedTracker.getBps());

          // Send cumulative ACK back
          channel.send(
            JSON.stringify({
              type: "cumulative-ack",
              fileId,
              highestSeq: rx.highestContiguous,
              missing: Array.from(rx.missing),
            })
          );
        }

        if (rx.nextOffsetToMerge === rx.metadata.size) {
          await this.finalizeTransfer(fileId);
        }
      }
    }
  }

  private async finalizeTransfer(fileId: string) {
    const rx = this.inProgressReceives.get(fileId);
    if (!rx) return; // Might have been finalised via done command instead of byte array condition

    this.inProgressReceives.delete(fileId);
    this.completedReceives.add(fileId);
    
    // Convert BlobParts incrementally
    const finalBlob = new Blob(rx.blobParts as any[], { type: rx.metadata.type || "application/octet-stream" });
    this.onComplete(fileId, finalBlob, rx.metadata);
  }

  static triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
