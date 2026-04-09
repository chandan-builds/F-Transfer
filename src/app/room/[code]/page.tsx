"use client";

import { useEffect, useState, useRef, use } from "react";
import { Header } from "@/components/Header";
import { GitStamp } from "@/components/GitStamp";
import { SignalingClient } from "@/lib/signaling";
import { WebRTCManager } from "@/lib/webrtc";
import { FileTransferManager, TransferMetadata } from "@/lib/file-transfer";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, X, CheckCircle2, FileJson, Users, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

const getSignalingUrl = () => {
  if (typeof window === "undefined") return "ws://127.0.0.1:3001";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:3001`;
};

interface FileProgress {
  id: string;
  name: string;
  size: number;
  transferred: number;
  status: "sending" | "receiving" | "complete" | "error";
  speed?: number;
}

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomId = code.toUpperCase();
  
  const [clientId, setClientId] = useState<string>("");
  const [peers, setPeers] = useState<{id: string, name: string, connected: boolean}[]>([]);
  const [activeTransfers, setActiveTransfers] = useState<FileProgress[]>([]);
  
  // Refs to hold our managers
  const sigClientRef = useRef<SignalingClient | null>(null);
  const rtcManagerRef = useRef<WebRTCManager | null>(null);
  const fileTransferRef = useRef<FileTransferManager | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    // 1. Setup File Transfer Manager (handles chunks in/out)
    const ftm = new FileTransferManager(
      // onProgress
      (fileId, bytes) => {
        setActiveTransfers(prev => prev.map(t => 
          t.id === fileId ? { ...t, transferred: bytes } : t
        ));
      },
      // onComplete
      (fileId, blob, metadata) => {
        setActiveTransfers(prev => prev.map(t => 
          t.id === fileId ? { ...t, transferred: t.size, status: 'complete' } : t
        ));
        // Auto-download when complete
        FileTransferManager.triggerDownload(blob, metadata.name);
      }
    );
    fileTransferRef.current = ftm;

    // 2. Setup WebRTC Manager (handles P2P channels)
    const rtc = new WebRTCManager(
      // signal outgoing messages to the WebSocket
      (data) => {
        sigClientRef.current?.send(data);
      },
      // handle peer events
      {
        onDataChannel: (peerId, channel) => {
          // When a channel opens, start listening for chunks
          channel.onmessage = (event) => {
            ftm.handleIncomingData(event.data);
            
            // If it's a new file header, add it to our UI
            if (typeof event.data === 'string') {
              try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'header') {
                  const m = msg.metadata as TransferMetadata;
                  setActiveTransfers(prev => [...prev, {
                    id: m.fileId,
                    name: m.name,
                    size: m.size,
                    transferred: 0,
                    status: 'receiving'
                  }]);
                }
              } catch (e) {}
            }
          };
        },
        onConnectionStateChange: (peerId, state) => {
          console.log(`Peer ${peerId} state:`, state);
          setPeers(prev => prev.map(p => 
            p.id === peerId ? { ...p, connected: state === 'connected' } : p
          ));
        }
      }
    );
    rtcManagerRef.current = rtc;

    // 3. Setup Signaling Client
    const sig = new SignalingClient(getSignalingUrl(), {
      onConnected: (id) => {
        setClientId(id);
        sig.join(roomId, `Peer-${id.substring(0, 4)}`);
      },
      onRoomJoined: (roomPeers) => {
        setPeers(roomPeers.map(p => ({ ...p, connected: false })));
        // We eagerly connect to existing peers in the room
        roomPeers.forEach(p => {
          rtc.connectToPeer(p.id);
        });
      },
      onPeerJoined: (peerId, name) => {
        setPeers(prev => [...prev, { id: peerId, name, connected: false }]);
      },
      onPeerLeft: (peerId) => {
        setPeers(prev => prev.filter(p => p.id !== peerId));
        rtc.cleanupPeer(peerId);
      },
      onMessage: (msg) => {
        rtc.handleSignalingMessage(msg);
      }
    });
    sigClientRef.current = sig;

    // Start connection
    sig.connect();

    return () => {
      // Cleanup on unmount
      rtc.disconnectAll();
      sig.disconnect();
    };
  }, [roomId]);

  // Handle Drag & Drop
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
  };

  const handleFiles = (files: File[]) => {
    // We send files to all connected peers
    const rtc = rtcManagerRef.current;
    const ftm = fileTransferRef.current;
    
    if (!rtc || !ftm) return;
    
    // We get the channels directly from the internal state by peeking,
    // or by forcing our manager to broadcast. For now, doing it cleanly:
    // (A more pure way is exposing a sendToAll method on WebRTCManager)
    const connectedPeerIds = peers.filter(p => p.connected).map(p => p.id);
    if (connectedPeerIds.length === 0) {
      alert("No peers connected yet!");
      return;
    }

    files.forEach(file => {
      const fileId = `${file.name}-${Date.now()}`;
      
      setActiveTransfers(prev => [...prev, {
        id: fileId,
        name: file.name,
        size: file.size,
        transferred: 0,
        status: 'sending'
      }]);

      connectedPeerIds.forEach(peerId => {
        // Accessing private map via any cast for simplicity here, 
        // normally we'd add `getDataChannel(peerId)` to WebRTCManager
        const dc = (rtc as any).dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') {
          ftm.sendFile(file, dc, (fId, bytes) => {
            setActiveTransfers(prev => prev.map(t => 
              t.id === fId ? { ...t, transferred: bytes } : t
            ));
            if (bytes >= file.size) {
              setActiveTransfers(prev => prev.map(t => 
                t.id === fId ? { ...t, status: 'complete' } : t
              ));
            }
          }).catch(err => {
            console.error("Transfer failed", err);
            setActiveTransfers(prev => prev.map(t => 
              t.id === fileId ? { ...t, status: 'error' } : t
            ));
          });
        }
      });
    });
  };

  return (
    <main className="min-h-screen flex flex-col">
      <Header roomCode={roomId} />
      
      <div className="flex-1 max-w-7xl mx-auto w-full p-4 grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Left Col: Dropzone & Active Transfers */}
        <div className="md:col-span-2 space-y-6 flex flex-col h-full">
          
          <div 
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              "flex-1 min-h-[300px] border-2 border-dashed rounded-2xl flex flex-col items-center justify-center transition-all bg-surface/30 backdrop-blur-sm relative overflow-hidden group",
              isDragging ? "border-primary bg-primary/10 scale-[1.02]" : "border-border hover:border-primary/50"
            )}
          >
            <input 
              type="file" 
              multiple 
              className="hidden" 
              ref={fileInputRef} 
              onChange={onFileInput}
            />
            
            <div className="bg-primary/20 p-6 rounded-full mb-4 text-primary group-hover:scale-110 transition-transform">
              <Upload size={40} />
            </div>
            <h2 className="text-2xl font-bold font-heading mb-2">Drop files here to share</h2>
            <p className="text-muted mb-6 px-4 text-center">Files are encrypted and sent directly to peers over LAN. No size limits.</p>
            
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="px-6 py-3 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-full font-bold transition-colors shadow-lg"
            >
              Browse Files
            </button>
          </div>

          {activeTransfers.length > 0 && (
            <div className="glass rounded-2xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <Activity size={20} className="text-accent" />
                Active Transfers
              </h3>
              <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                <AnimatePresence>
                  {activeTransfers.map(tf => {
                    const percent = Math.min(100, Math.round((tf.transferred / tf.size) * 100));
                    return (
                      <motion.div 
                        key={tf.id}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="bg-background rounded-xl p-4 border border-border flex items-center gap-4"
                      >
                        <div className="p-3 bg-surface rounded-lg">
                          <FileJson size={24} className={tf.status === 'receiving' ? 'text-accent' : 'text-primary'} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center mb-1">
                            <h4 className="font-medium truncate pr-4">{tf.name}</h4>
                            <span className={cn("text-xs px-2 py-1 rounded-md", 
                              tf.status === 'complete' ? "bg-success/20 text-success" : 
                              tf.status === 'error' ? "bg-error/20 text-error" : 
                              "bg-surface text-muted"
                            )}>
                              {tf.status}
                            </span>
                          </div>
                          <div className="flex justify-between text-xs text-muted mb-2">
                            <span>{(tf.size / 1024 / 1024).toFixed(2)} MB</span>
                            <span>{percent}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-surface rounded-full overflow-hidden">
                            <div 
                              className={cn("h-full transition-all duration-300", 
                                tf.status === 'complete' ? "bg-success" : 
                                tf.status === 'error' ? "bg-error" : 
                                tf.status === 'receiving' ? "bg-accent" : "bg-primary"
                              )}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>

        {/* Right Col: Peers List */}
        <div className="glass rounded-2xl p-6 h-fit sticky top-24">
          <div className="flex items-center justify-between mb-6 border-b border-border/50 pb-4">
            <h3 className="font-bold text-lg flex items-center gap-2">
              <Users size={20} className="text-primary" />
              Users in Room
            </h3>
            <span className="bg-primary/20 text-primary font-mono text-xs px-2 py-1 rounded-md">
              {peers.length + 1}
            </span>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/10 border border-primary/20">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center font-bold text-primary">
                ME
              </div>
              <div>
                <p className="font-bold text-sm">You</p>
                <p className="text-xs text-muted font-mono">{clientId.substring(0, 8)}</p>
              </div>
            </div>

            {peers.length === 0 ? (
              <div className="text-center py-8 text-muted text-sm px-4">
                Share the room code <span className="font-bold text-foreground">{roomId}</span> with others to let them join.
              </div>
            ) : (
              peers.map((p) => (
                <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl bg-background border border-border">
                  <div className="w-10 h-10 rounded-full bg-surface flex items-center justify-center font-bold text-muted">
                    {p.name.substring(0, 1)}
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-sm flex items-center gap-2">
                      {p.name}
                      {p.connected && <CheckCircle2 size={14} className="text-success" />}
                    </p>
                    <p className="text-xs text-muted flex items-center gap-1">
                      <span className={cn("w-2 h-2 rounded-full", p.connected ? "bg-success" : "bg-warning animate-pulse")} />
                      {p.connected ? "Connected (LAN)" : "Connecting..."}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>
      <GitStamp />
    </main>
  );
}
