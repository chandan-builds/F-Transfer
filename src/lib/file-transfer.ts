export type TransferMetadata = {
  fileId: string;
  name: string;
  size: number;
  type: string;
  totalChunks: number;
};

export type ProgressCallback = (fileId: string, bytesTransferred: number) => void;
export type CompleteCallback = (fileId: string, file: Blob, metadata: TransferMetadata) => void;

// ─── Performance tuning ──────────────────────────────────────────
// 256KB chunks → ~4× less overhead than 64KB, well within SCTP limits
const CHUNK_SIZE = 256 * 1024;
// Use event-driven backpressure: buffer low watermark
const BUFFER_LOW_THRESHOLD = 512 * 1024;   // resume sending when buffer drops below 512KB
const BUFFER_HIGH_THRESHOLD = 2 * 1024 * 1024; // pause sending when buffer exceeds 2MB

// ─── Transfer Controller ─────────────────────────────────────────
// Tracks live state for a single outbound transfer so we can
// pause / resume / cancel from the UI.
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
    // Also unblock the loop so it can exit
    this.resume();
  }

  /** Returns a promise that resolves when resume() is called */
  waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => {
      this._resumeResolver = resolve;
    });
  }
}

// ─── Speed Tracker ───────────────────────────────────────────────
// A tiny ring-buffer that stores recent byte snapshots so we can
// compute a smoothed MB/s figure instead of a jittery instant one.
class SpeedTracker {
  private samples: { time: number; bytes: number }[] = [];
  private windowMs = 2000; // 2-second sliding window

  push(bytes: number) {
    const now = performance.now();
    this.samples.push({ time: now, bytes });
    // Prune old samples
    while (this.samples.length > 0 && now - this.samples[0].time > this.windowMs) {
      this.samples.shift();
    }
  }

  /** Returns bytes per second averaged over the window */
  getBps(): number {
    if (this.samples.length < 2) return 0;
    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];
    const dt = (newest.time - oldest.time) / 1000; // seconds
    if (dt === 0) return 0;
    const db = newest.bytes - oldest.bytes;
    return db / dt;
  }
}

// ─── Enhanced progress callback with speed ───────────────────────
export type SpeedProgressCallback = (
  fileId: string,
  bytesTransferred: number,
  speedBps: number
) => void;

// ─── FileTransferManager ─────────────────────────────────────────
export class FileTransferManager {
  private inProgressReceives: Map<string, {
    metadata: TransferMetadata;
    chunks: Uint8Array[];
    receivedChunks: number;
    receivedBytes: number;
    speedTracker: SpeedTracker;
  }> = new Map();

  // Registry of active outbound controllers so the UI can pause/cancel
  activeControllers: Map<string, TransferController> = new Map();

  private onProgress: SpeedProgressCallback;
  private onComplete: CompleteCallback;

  constructor(onProgress: SpeedProgressCallback, onComplete: CompleteCallback) {
    this.onProgress = onProgress;
    this.onComplete = onComplete;
  }

  // ── Outbound: send a file ──────────────────────────────────────
  async sendFile(
    file: File,
    channel: RTCDataChannel,
    onSendProgress: SpeedProgressCallback,
    controller?: TransferController
  ): Promise<void> {
    const fileId = `${file.name}-${Date.now()}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const ctrl = controller ?? new TransferController();

    // Register so the UI can call ctrl.pause() / ctrl.cancel()
    this.activeControllers.set(fileId, ctrl);

    const metadata: TransferMetadata = {
      fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      totalChunks
    };

    // 1. Send metadata header as text
    channel.send(JSON.stringify({ type: 'header', metadata }));

    // 2. Setup event-driven backpressure
    channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

    const speedTracker = new SpeedTracker();
    let offset = 0;
    let chunkIndex = 0;

    // Helper: wait until bufferedAmount drops
    const waitForDrain = (): Promise<void> =>
      new Promise((resolve) => {
        const handler = () => {
          channel.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', handler);
      });

    // 3. Stream chunks
    while (offset < file.size) {
      // ── Cancel check ──
      if (ctrl.cancelled) {
        channel.send(JSON.stringify({ type: 'cancel', fileId }));
        this.activeControllers.delete(fileId);
        throw new Error('Transfer cancelled');
      }

      // ── Pause check ──
      if (ctrl.paused) {
        await ctrl.waitForResume();
        if (ctrl.cancelled) {
          channel.send(JSON.stringify({ type: 'cancel', fileId }));
          this.activeControllers.delete(fileId);
          throw new Error('Transfer cancelled');
        }
      }

      // ── Backpressure: wait if the send buffer is full ──
      if (channel.bufferedAmount > BUFFER_HIGH_THRESHOLD) {
        await waitForDrain();
      }

      // ── Read chunk using the fast slice→arrayBuffer path ──
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const slice = file.slice(offset, end);
      const buffer = await slice.arrayBuffer();

      // ── Build a compact binary frame ──
      // Layout: [4 bytes header-len][JSON header bytes][file data bytes]
      const headerStr = `{"t":"c","f":"${fileId}","i":${chunkIndex}}`;
      const headerBytes = new TextEncoder().encode(headerStr);
      const headerLen = headerBytes.length;

      const payload = new Uint8Array(4 + headerLen + buffer.byteLength);
      new DataView(payload.buffer).setUint32(0, headerLen);
      payload.set(headerBytes, 4);
      payload.set(new Uint8Array(buffer), 4 + headerLen);

      channel.send(payload);

      offset = end;
      chunkIndex++;

      speedTracker.push(offset);
      onSendProgress(fileId, offset, speedTracker.getBps());
    }

    this.activeControllers.delete(fileId);
  }

  // ── Inbound: handle received data ──────────────────────────────
  handleIncomingData(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'header') {
          const { metadata } = msg;
          this.inProgressReceives.set(metadata.fileId, {
            metadata,
            chunks: new Array(metadata.totalChunks),
            receivedChunks: 0,
            receivedBytes: 0,
            speedTracker: new SpeedTracker()
          });
        } else if (msg.type === 'cancel') {
          // Sender cancelled – discard partial data
          this.inProgressReceives.delete(msg.fileId);
        }
      } catch (err) {
        console.error('Failed to parse text message', err);
      }
    } else if (data instanceof ArrayBuffer) {
      const payload = new Uint8Array(data);
      if (payload.byteLength < 4) return;

      const headerLength = new DataView(payload.buffer).getUint32(0);
      const headerBytes = payload.slice(4, 4 + headerLength);
      const chunkBytes = payload.slice(4 + headerLength);

      const headerStr = new TextDecoder().decode(headerBytes);
      try {
        const header = JSON.parse(headerStr);
        // Compact key names: t=type, f=fileId, i=chunkIndex
        if (header.t === 'c') {
          const fileId = header.f;
          const chunkIndex = header.i;
          const transfer = this.inProgressReceives.get(fileId);

          if (transfer) {
            transfer.chunks[chunkIndex] = chunkBytes;
            transfer.receivedChunks++;
            transfer.receivedBytes += chunkBytes.byteLength;
            transfer.speedTracker.push(transfer.receivedBytes);

            this.onProgress(fileId, transfer.receivedBytes, transfer.speedTracker.getBps());

            if (transfer.receivedChunks === transfer.metadata.totalChunks) {
              // Assembly complete!
              const blob = new Blob(transfer.chunks as any as BlobPart[], {
                type: transfer.metadata.type
              });
              this.onComplete(fileId, blob, transfer.metadata);
              this.inProgressReceives.delete(fileId);
            }
          }
        }
      } catch (err) {
        console.error('Failed to parse chunk header', err);
      }
    }
  }

  // ── Utility to download the completed blob ─────────────────────
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
