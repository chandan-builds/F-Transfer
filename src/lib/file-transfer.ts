export type TransferMetadata = {
  fileId: string;
  name: string;
  size: number;
  type: string;
  totalChunks: number;
  hash: string;
};

export type ProgressCallback = (fileId: string, bytesTransferred: number) => void;
export type CompleteCallback = (fileId: string, file: Blob, metadata: TransferMetadata) => void;
export type ErrorCallback = (fileId: string, error: string) => void;
export type SpeedProgressCallback = (fileId: string, bytesTransferred: number, speedBps: number) => void;

// Strict 64KB chunk size to avoid DataChannel buffer overflow
const CHUNK_SIZE = 64 * 1024;
const BUFFER_LOW_THRESHOLD = 128 * 1024;  
const BUFFER_HIGH_THRESHOLD = 512 * 1024;

export class TransferController {
  paused = false;
  cancelled = false;
  private _resumeResolver: (() => void) | null = null;

  pause() { this.paused = true; }
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
    return new Promise((resolve) => {
      this._resumeResolver = resolve;
    });
  }
}

class SpeedTracker {
  private samples: { time: number; bytes: number }[] = [];
  private windowMs = 2000;

  push(bytes: number) {
    const now = performance.now();
    this.samples.push({ time: now, bytes });
    while (this.samples.length > 0 && now - this.samples[0].time > this.windowMs) {
      this.samples.shift();
    }
  }

  getBps(): number {
    if (this.samples.length < 2) return 0;
    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];
    const dt = (newest.time - oldest.time) / 1000;
    if (dt === 0) return 0;
    return (newest.bytes - oldest.bytes) / dt;
  }
}

async function computeHash(blob: Blob): Promise<string> {
  // Avoid fully buffer.arrayBuffer() loading of very large files on constrained devices.
  // We'll digest up to early 50MB to get an integrity fingerprint.
  const slice = blob.size > 50_000_000 ? blob.slice(0, 50_000_000) : blob; 
  const buffer = await slice.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export class FileTransferManager {
  private inProgressReceives: Map<string, {
    metadata: TransferMetadata;
    chunks: Uint8Array[];
    receivedChunks: number;
    receivedBytes: number;
    speedTracker: SpeedTracker;
  }> = new Map();

  private activeSends: Map<string, {
    channel: RTCDataChannel;
    lastAcked: number;
    headerAckResolver: (() => void) | null;
    resumeAckResolver: ((nextChunk: number) => void) | null;
  }> = new Map();

  activeControllers: Map<string, TransferController> = new Map();

  private onProgress: SpeedProgressCallback;
  private onComplete: CompleteCallback;
  private onError: ErrorCallback;

  constructor(onProgress: SpeedProgressCallback, onComplete: CompleteCallback, onError: ErrorCallback) {
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
  }

  async sendFile(
    file: File,
    channel: RTCDataChannel,
    onSendProgress: SpeedProgressCallback,
    controller?: TransferController
  ): Promise<void> {
    const fileId = `${file.name}-${Date.now()}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const ctrl = controller ?? new TransferController();

    this.activeControllers.set(fileId, ctrl);

    const hash = await computeHash(file);
    const metadata: TransferMetadata = {
      fileId, name: file.name, size: file.size, type: file.type, totalChunks, hash
    };

    const sendState = {
      channel,
      lastAcked: -1,
      headerAckResolver: null as (() => void) | null,
      resumeAckResolver: null as ((nc: number) => void) | null
    };
    this.activeSends.set(fileId, sendState);

    // Send header via JSON
    channel.send(JSON.stringify({ type: 'header', metadata }));

    // Wait for header ACK to ensure the receiver is fully ready
    await new Promise<void>((resolve) => {
      sendState.headerAckResolver = resolve;
      // Auto-fallback in case of slow or dropped signaling for header-ack
      setTimeout(() => { if (sendState.headerAckResolver) resolve(); }, 5000);
    });
    sendState.headerAckResolver = null;

    channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
    const speedTracker = new SpeedTracker();
    let chunkIndex = 0;

    const waitForDrain = (): Promise<void> =>
      new Promise((resolve) => {
        if (channel.bufferedAmount <= BUFFER_LOW_THRESHOLD) {
          resolve();
          return;
        }
        const handler = () => {
          channel.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', handler);
      });

    try {
      while (chunkIndex < totalChunks) {
        if (ctrl.cancelled) {
          channel.send(JSON.stringify({ type: 'cancel', fileId }));
          throw new Error('Transfer cancelled');
        }

        if (ctrl.paused) {
          channel.send(JSON.stringify({ type: 'pause', fileId }));
          await ctrl.waitForResume();
          if (ctrl.cancelled) {
            channel.send(JSON.stringify({ type: 'cancel', fileId }));
            throw new Error('Transfer cancelled');
          }
          
          // Request resume chunk index explicitly
          channel.send(JSON.stringify({ type: 'request-resume', fileId }));
          chunkIndex = await new Promise<number>((resolve) => {
            sendState.resumeAckResolver = resolve;
            setTimeout(() => {
              if (sendState.resumeAckResolver) {
                resolve(sendState.lastAcked + 1);
              }
            }, 5000);
          });
          sendState.resumeAckResolver = null;
          if (chunkIndex >= totalChunks) break;
        }

        if (channel.readyState !== 'open') {
          throw new Error('DataChannel closed unexpectedly');
        }

        if (channel.bufferedAmount > BUFFER_HIGH_THRESHOLD) {
          await waitForDrain();
        }

        const offset = chunkIndex * CHUNK_SIZE;
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const slice = file.slice(offset, end);
        const buffer = await slice.arrayBuffer();

        // Safe Binary protocol layout: fileIdLen (4) | fileId (bytes) | chunkIndex (4) | totalChunks (4) | data
        const idBytes = new TextEncoder().encode(fileId);
        const payload = new Uint8Array(4 + idBytes.length + 8 + buffer.byteLength);
        const view = new DataView(payload.buffer);
        view.setUint32(0, idBytes.length);
        payload.set(idBytes, 4);
        view.setUint32(4 + idBytes.length, chunkIndex);
        view.setUint32(8 + idBytes.length, totalChunks);
        payload.set(new Uint8Array(buffer), 12 + idBytes.length);

        channel.send(payload);

        speedTracker.push(end);
        onSendProgress(fileId, end, speedTracker.getBps());

        chunkIndex++;
      }
      
      // Notify completion explicitly
      channel.send(JSON.stringify({ type: 'done', fileId }));
    } catch (err: any) {
      if (err.message !== 'Transfer cancelled') {
        try {
          channel.send(JSON.stringify({ type: 'error', fileId, message: err.message }));
        } catch(e) {}
      }
      this.cleanupSend(fileId);
      throw err;
    }

    this.cleanupSend(fileId);
  }

  private cleanupSend(fileId: string) {
    this.activeSends.delete(fileId);
    this.activeControllers.delete(fileId);
  }

  handleIncomingData(data: string | ArrayBuffer, channel?: RTCDataChannel) {
    if (typeof data === 'string') {
      this.handleJsonData(data, channel);
    } else if (data instanceof ArrayBuffer) {
      this.handleBinaryData(data, channel);
    }
  }

  private handleJsonData(data: string, channel?: RTCDataChannel) {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'header') {
        this.inProgressReceives.set(msg.metadata.fileId, {
          metadata: msg.metadata,
          chunks: new Array(msg.metadata.totalChunks),
          receivedChunks: 0,
          receivedBytes: 0,
          speedTracker: new SpeedTracker()
        });
        if (channel && channel.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'header-ack', fileId: msg.metadata.fileId }));
        }
      } else if (msg.type === 'header-ack') {
        const sendState = this.activeSends.get(msg.fileId);
        if (sendState && sendState.headerAckResolver) {
          sendState.headerAckResolver();
          sendState.headerAckResolver = null;
        }
      } else if (msg.type === 'ack') {
        const sendState = this.activeSends.get(msg.fileId);
        if (sendState) {
          sendState.lastAcked = Math.max(sendState.lastAcked, msg.chunkIndex);
        }
      } else if (msg.type === 'request-resume') {
        const rx = this.inProgressReceives.get(msg.fileId);
        if (rx && channel && channel.readyState === 'open') {
          let nextChunk = 0;
          for (let i = 0; i < rx.metadata.totalChunks; i++) {
            if (!rx.chunks[i]) {
              nextChunk = i;
              break;
            }
          }
          channel.send(JSON.stringify({ type: 'resume-ack', fileId: msg.fileId, nextChunk }));
        }
      } else if (msg.type === 'resume-ack') {
        const sendState = this.activeSends.get(msg.fileId);
        if (sendState && sendState.resumeAckResolver) {
          sendState.resumeAckResolver(msg.nextChunk);
          sendState.resumeAckResolver = null;
        }
      } else if (msg.type === 'cancel' || msg.type === 'error') {
        this.inProgressReceives.delete(msg.fileId);
        if (msg.type === 'error') {
          this.onError(msg.fileId, msg.message || 'Remote side encountered an error');
        }
      } else if (msg.type === 'done') {
         // Optionally rely on completion event, but batch handles this inherently.
      }
    } catch (err) {
      console.error('Failed to parse signaling json message over datachannel', err);
    }
  }

  private handleBinaryData(data: ArrayBuffer, channel?: RTCDataChannel) {
    const payload = new Uint8Array(data);
    if (payload.byteLength < 4) return;

    const view = new DataView(payload.buffer);
    const idLen = view.getUint32(0);
    const idBytes = payload.slice(4, 4 + idLen);
    const fileId = new TextDecoder().decode(idBytes);
    const chunkIndex = view.getUint32(4 + idLen);
    const chunkBytes = payload.slice(12 + idLen);

    const transfer = this.inProgressReceives.get(fileId);
    if (!transfer) return;

    if (!transfer.chunks[chunkIndex]) {
      transfer.chunks[chunkIndex] = chunkBytes;
      transfer.receivedChunks++;
      transfer.receivedBytes += chunkBytes.byteLength;
      transfer.speedTracker.push(transfer.receivedBytes);

      this.onProgress(fileId, transfer.receivedBytes, transfer.speedTracker.getBps());

      if (transfer.receivedChunks === transfer.metadata.totalChunks) {
        this.finalizeTransfer(fileId).catch(err => {
          this.onError(fileId, err.message);
        });
      }
    }

    // ACK periodically to prevent UDP flood but keep sliding window updated
    if (channel && channel.readyState === 'open' && chunkIndex % 16 === 0) {
      channel.send(JSON.stringify({ type: 'ack', fileId, chunkIndex }));
    }
  }

  private async finalizeTransfer(fileId: string) {
    const rx = this.inProgressReceives.get(fileId);
    if (!rx) return;
    this.inProgressReceives.delete(fileId);

    const blob = new Blob(rx.chunks as any as BlobPart[], { type: rx.metadata.type });
    
    if (rx.metadata.hash) {
      const computedHash = await computeHash(blob);
      if (computedHash !== rx.metadata.hash) {
        throw new Error(`Data corruption detected. SHA-256 hash mismatch.`);
      }
    }

    this.onComplete(fileId, blob, rx.metadata);
  }

  static triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}
