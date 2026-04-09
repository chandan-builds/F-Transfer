export type TransferMetadata = {
  fileId: string;
  name: string;
  size: number;
  type: string;
  totalChunks: number;
};

export type ProgressCallback = (fileId: string, bytesTransferred: number) => void;
export type CompleteCallback = (fileId: string, file: Blob, metadata: TransferMetadata) => void;

// 64KB chunk size balances overhead and performance in DataChannels
const CHUNK_SIZE = 64 * 1024;
// Buffer threshold before we wait (avoid Out Of Memory exceptions)
const BUFFER_THRESHOLD = 5 * 1024 * 1024; 

export class FileTransferManager {
  private inProgressReceives: Map<string, {
    metadata: TransferMetadata;
    chunks: Uint8Array[];
    receivedChunks: number;
    receivedBytes: number;
  }> = new Map();

  private onProgress: ProgressCallback;
  private onComplete: CompleteCallback;

  constructor(onProgress: ProgressCallback, onComplete: CompleteCallback) {
    this.onProgress = onProgress;
    this.onComplete = onComplete;
  }

  // Sends the file with backpressure management
  async sendFile(
    file: File, 
    channel: RTCDataChannel, 
    onSendProgress: ProgressCallback
  ): Promise<void> {
    const fileId = `${file.name}-${Date.now()}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    
    const metadata: TransferMetadata = {
      fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      totalChunks
    };

    // 1. Send metadata header
    channel.send(JSON.stringify({ type: 'header', metadata }));

    let offset = 0;
    let chunkIndex = 0;

    // 2. Read and send file in chunks
    const reader = new FileReader();

    return new Promise((resolve, reject) => {
      const readNextChunk = () => {
        if (offset >= file.size) {
          resolve();
          return;
        }

        // Wait if channel buffer is filling up (backpressure control)
        if (channel.bufferedAmount > BUFFER_THRESHOLD) {
          setTimeout(readNextChunk, 10);
          return;
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
      };

      reader.onload = (e) => {
        if (e.target?.result && channel.readyState === 'open') {
          const buffer = e.target.result as ArrayBuffer;
          
          // Send a 16-byte header with the ArrayBuffer so the receiver knows which file this chunk belongs to
          // Simplest structure: [36 bytes fileId string (assumed padding if less) | ArrayBuffer] -> since DataChannels don't guarantee exact order to files if we interleave, we just send chunks sequentially per file.
          
          // Better approach for our direct channel: we aren't interleaving within one specific channel for a single file transfer right now.
          // We will prepend a short JSON header string converted to Uint8Array to every binary chunk.
          const headerStr = JSON.stringify({ type: 'chunk', fileId, chunkIndex });
          const headerBytes = new TextEncoder().encode(headerStr);
          const headerLength = headerBytes.length;
          
          // 4 bytes for header length + header bytes + data
          const payload = new Uint8Array(4 + headerLength + buffer.byteLength);
          new DataView(payload.buffer).setUint32(0, headerLength);
          payload.set(headerBytes, 4);
          payload.set(new Uint8Array(buffer), 4 + headerLength);

          channel.send(payload);

          offset += buffer.byteLength;
          chunkIndex++;
          onSendProgress(fileId, offset);
          
          // Queue next read
          readNextChunk();
        } else {
          reject(new Error('Channel closed or read error'));
        }
      };

      reader.onerror = (err) => reject(err);

      // Start the transfer
      readNextChunk();
    });
  }

  // Handle incoming data
  handleIncomingData(data: any | ArrayBuffer) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'header') {
          const { metadata } = msg;
          this.inProgressReceives.set(metadata.fileId, {
            metadata,
            chunks: new Array(metadata.totalChunks),
            receivedChunks: 0,
            receivedBytes: 0
          });
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
        if (header.type === 'chunk') {
          const { fileId, chunkIndex } = header;
          const transfer = this.inProgressReceives.get(fileId);
          
          if (transfer) {
            transfer.chunks[chunkIndex] = chunkBytes;
            transfer.receivedChunks++;
            transfer.receivedBytes += chunkBytes.byteLength;
            
            this.onProgress(fileId, transfer.receivedBytes);
            
            if (transfer.receivedChunks === transfer.metadata.totalChunks) {
              // Assembly complete!
              const blob = new Blob(transfer.chunks as any as BlobPart[], { type: transfer.metadata.type });
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

  // Utility to download the completed blob
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
