"use client";

import { useEffect, useState, useRef, useCallback, use } from "react";
import { Header } from "@/components/Header";
import { GitStamp } from "@/components/GitStamp";
import { SignalingClient } from "@/lib/signaling";
import { WebRTCManager } from "@/lib/webrtc";
import {
  FileTransferManager,
  TransferController,
  TransferMetadata,
} from "@/lib/file-transfer";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  CheckCircle2,
  FileJson,
  Users,
  Activity,
  Pause,
  Play,
  XCircle,
  Gauge,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Signaling URL resolution ────────────────────────────────────
const getSignalingUrl = () => {
  if (process.env.NEXT_PUBLIC_SIGNALING_URL) {
    return process.env.NEXT_PUBLIC_SIGNALING_URL;
  }
  if (typeof window === "undefined") return "ws://127.0.0.1:3001";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:3001`;
};

// ─── Types ───────────────────────────────────────────────────────
interface FileProgress {
  id: string;
  name: string;
  size: number;
  transferred: number;
  status: "sending" | "receiving" | "complete" | "error" | "cancelled" | "paused";
  speed: number;          // bytes per second
  startTime: number;      // performance.now() at start
  controller?: TransferController;
}

// ─── Helpers ─────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i < 2 ? 0 : 2)} ${sizes[i]}`;
}
function formatSpeed(bps: number): string {
  if (bps === 0) return "—";
  return `${formatBytes(bps)}/s`;
}
function formatEta(remaining: number, bps: number): string {
  if (bps <= 0) return "—";
  const secs = Math.ceil(remaining / bps);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

// ─── Page ────────────────────────────────────────────────────────
export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomId = code.toUpperCase();

  const [clientId, setClientId] = useState("");
  const [peers, setPeers] = useState<{ id: string; name: string; connected: boolean }[]>([]);
  const [activeTransfers, setActiveTransfers] = useState<FileProgress[]>([]);

  const sigClientRef = useRef<SignalingClient | null>(null);
  const rtcManagerRef = useRef<WebRTCManager | null>(null);
  const fileTransferRef = useRef<FileTransferManager | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isDragging, setIsDragging] = useState(false);

  // ── Mutable updater to avoid re-creating the effect ────────────
  const updateTransfer = useCallback(
    (id: string, patch: Partial<FileProgress>) => {
      setActiveTransfers((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
      );
    },
    []
  );

  // ── Setup signaling + WebRTC + file transfer ───────────────────
  useEffect(() => {
    // 1. File Transfer Manager
    const ftm = new FileTransferManager(
      // onProgress (with speed)
      (fileId, bytes, speedBps) => {
        updateTransfer(fileId, { transferred: bytes, speed: speedBps });
      },
      // onComplete
      (fileId, blob, metadata) => {
        updateTransfer(fileId, {
          transferred: metadata.size,
          status: "complete",
          speed: 0,
        });
        FileTransferManager.triggerDownload(blob, metadata.name);
      }
    );
    fileTransferRef.current = ftm;

    // 2. WebRTC Manager
    const rtc = new WebRTCManager(
      (data) => sigClientRef.current?.send(data),
      {
        onDataChannel: (_peerId, channel) => {
          channel.onmessage = (event) => {
            ftm.handleIncomingData(event.data);

            // Register incoming file in UI
            if (typeof event.data === "string") {
              try {
                const msg = JSON.parse(event.data);
                if (msg.type === "header") {
                  const m = msg.metadata as TransferMetadata;
                  setActiveTransfers((prev) => [
                    ...prev,
                    {
                      id: m.fileId,
                      name: m.name,
                      size: m.size,
                      transferred: 0,
                      status: "receiving",
                      speed: 0,
                      startTime: performance.now(),
                    },
                  ]);
                } else if (msg.type === "cancel") {
                  updateTransfer(msg.fileId, { status: "cancelled", speed: 0 });
                }
              } catch (_e) {}
            }
          };
        },
        onConnectionStateChange: (peerId, state) => {
          setPeers((prev) =>
            prev.map((p) =>
              p.id === peerId ? { ...p, connected: state === "connected" } : p
            )
          );
        },
      }
    );
    rtcManagerRef.current = rtc;

    // 3. Signaling Client
    const sig = new SignalingClient(getSignalingUrl(), {
      onConnected: (id) => {
        setClientId(id);
        sig.join(roomId, `Peer-${id.substring(0, 4)}`);
      },
      onRoomJoined: (roomPeers) => {
        setPeers(roomPeers.map((p) => ({ ...p, connected: false })));
        roomPeers.forEach((p) => rtc.connectToPeer(p.id));
      },
      onPeerJoined: (peerId, name) => {
        setPeers((prev) => [...prev, { id: peerId, name, connected: false }]);
      },
      onPeerLeft: (peerId) => {
        setPeers((prev) => prev.filter((p) => p.id !== peerId));
        rtc.cleanupPeer(peerId);
      },
      onMessage: (msg) => rtc.handleSignalingMessage(msg),
    });
    sigClientRef.current = sig;
    sig.connect();

    return () => {
      rtc.disconnectAll();
      sig.disconnect();
    };
  }, [roomId, updateTransfer]);

  // ── Drag & Drop ────────────────────────────────────────────────
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) handleFiles(Array.from(e.dataTransfer.files));
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFiles(Array.from(e.target.files));
  };

  // ── Send files ─────────────────────────────────────────────────
  const handleFiles = (files: File[]) => {
    const rtc = rtcManagerRef.current;
    const ftm = fileTransferRef.current;
    if (!rtc || !ftm) return;

    const connectedPeerIds = peers.filter((p) => p.connected).map((p) => p.id);
    if (connectedPeerIds.length === 0) {
      alert("No peers connected yet!");
      return;
    }

    files.forEach((file) => {
      const controller = new TransferController();
      const fileId = `${file.name}-${Date.now()}`;

      setActiveTransfers((prev) => [
        ...prev,
        {
          id: fileId,
          name: file.name,
          size: file.size,
          transferred: 0,
          status: "sending",
          speed: 0,
          startTime: performance.now(),
          controller,
        },
      ]);

      connectedPeerIds.forEach((peerId) => {
        const dc = rtc.getDataChannel(peerId);
        if (dc && dc.readyState === "open") {
          ftm
            .sendFile(file, dc, (fId, bytes, speedBps) => {
              updateTransfer(fId, { transferred: bytes, speed: speedBps });
              if (bytes >= file.size) {
                updateTransfer(fId, { status: "complete", speed: 0 });
              }
            }, controller)
            .catch((err) => {
              const msg = (err as Error).message;
              if (msg === "Transfer cancelled") {
                updateTransfer(fileId, { status: "cancelled", speed: 0 });
              } else {
                updateTransfer(fileId, { status: "error", speed: 0 });
              }
            });
        }
      });
    });
  };

  // ── Transfer controls ──────────────────────────────────────────
  const handlePause = (tf: FileProgress) => {
    tf.controller?.pause();
    updateTransfer(tf.id, { status: "paused", speed: 0 });
  };
  const handleResume = (tf: FileProgress) => {
    tf.controller?.resume();
    updateTransfer(tf.id, { status: "sending" });
  };
  const handleCancel = (tf: FileProgress) => {
    tf.controller?.cancel();
    updateTransfer(tf.id, { status: "cancelled", speed: 0 });
  };

  // ── Render ─────────────────────────────────────────────────────
  return (
    <main className="min-h-screen flex flex-col">
      <Header roomCode={roomId} />

      <div className="flex-1 max-w-7xl mx-auto w-full p-4 grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* ──────────── Left: Dropzone + Transfers ──────────── */}
        <div className="md:col-span-2 space-y-6 flex flex-col h-full">
          {/* Dropzone */}
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              "flex-1 min-h-[300px] border-2 border-dashed rounded-2xl flex flex-col items-center justify-center transition-all bg-surface/30 backdrop-blur-sm relative overflow-hidden group",
              isDragging
                ? "border-primary bg-primary/10 scale-[1.02]"
                : "border-border hover:border-primary/50"
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
            <h2 className="text-2xl font-bold font-heading mb-2">
              Drop files here to share
            </h2>
            <p className="text-muted mb-6 px-4 text-center">
              Files are encrypted and sent directly to peers over LAN. No size
              limits.
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-6 py-3 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-full font-bold transition-colors shadow-lg"
            >
              Browse Files
            </button>
          </div>

          {/* ──────────── Active Transfers ──────────── */}
          {activeTransfers.length > 0 && (
            <div className="glass rounded-2xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <Activity size={20} className="text-accent" />
                Active Transfers
              </h3>
              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                <AnimatePresence>
                  {activeTransfers.map((tf) => {
                    const percent = Math.min(
                      100,
                      Math.round((tf.transferred / tf.size) * 100)
                    );
                    const remaining = tf.size - tf.transferred;
                    const isActive =
                      tf.status === "sending" || tf.status === "receiving";
                    const isPaused = tf.status === "paused";
                    const isDone =
                      tf.status === "complete" || tf.status === "cancelled" || tf.status === "error";

                    return (
                      <motion.div
                        key={tf.id}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        className="bg-background rounded-xl p-4 border border-border"
                      >
                        {/* Row 1: Icon + Name + Status + Controls */}
                        <div className="flex items-center gap-3">
                          <div className="p-2.5 bg-surface rounded-lg shrink-0">
                            <FileJson
                              size={22}
                              className={
                                tf.status === "receiving"
                                  ? "text-accent"
                                  : "text-primary"
                              }
                            />
                          </div>

                          <div className="flex-1 min-w-0">
                            <h4 className="font-medium text-sm truncate pr-2">
                              {tf.name}
                            </h4>
                            <div className="flex items-center gap-2 text-xs text-muted mt-0.5">
                              {tf.status === "sending" && (
                                <ArrowUpFromLine size={12} className="text-primary" />
                              )}
                              {tf.status === "receiving" && (
                                <ArrowDownToLine size={12} className="text-accent" />
                              )}
                              <span>{formatBytes(tf.transferred)}</span>
                              <span className="text-border">/</span>
                              <span>{formatBytes(tf.size)}</span>
                            </div>
                          </div>

                          {/* Speed badge */}
                          {(isActive || isPaused) && (
                            <div className="flex items-center gap-1.5 bg-surface px-2.5 py-1 rounded-lg shrink-0">
                              <Gauge size={14} className="text-accent" />
                              <span className="text-xs font-mono font-medium text-accent">
                                {isPaused ? "Paused" : formatSpeed(tf.speed)}
                              </span>
                            </div>
                          )}

                          {/* Status badge */}
                          <span
                            className={cn(
                              "text-xs px-2.5 py-1 rounded-lg font-medium shrink-0",
                              tf.status === "complete" && "bg-success/20 text-success",
                              tf.status === "error" && "bg-error/20 text-error",
                              tf.status === "cancelled" && "bg-warning/20 text-warning",
                              tf.status === "paused" && "bg-warning/20 text-warning",
                              tf.status === "sending" && "bg-primary/20 text-primary",
                              tf.status === "receiving" && "bg-accent/20 text-accent"
                            )}
                          >
                            {tf.status === "complete" && (
                              <CheckCircle2 size={14} className="inline -mt-0.5 mr-1" />
                            )}
                            {tf.status}
                          </span>

                          {/* Controls: Pause / Resume / Cancel */}
                          {tf.controller && !isDone && (
                            <div className="flex items-center gap-1 shrink-0">
                              {isPaused ? (
                                <button
                                  onClick={() => handleResume(tf)}
                                  className="p-1.5 rounded-lg bg-success/20 text-success hover:bg-success/30 transition-colors"
                                  title="Resume"
                                >
                                  <Play size={16} />
                                </button>
                              ) : (
                                <button
                                  onClick={() => handlePause(tf)}
                                  className="p-1.5 rounded-lg bg-warning/20 text-warning hover:bg-warning/30 transition-colors"
                                  title="Pause"
                                >
                                  <Pause size={16} />
                                </button>
                              )}
                              <button
                                onClick={() => handleCancel(tf)}
                                className="p-1.5 rounded-lg bg-error/20 text-error hover:bg-error/30 transition-colors"
                                title="Cancel"
                              >
                                <XCircle size={16} />
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Row 2: Progress bar + ETA */}
                        <div className="mt-3">
                          <div className="h-2 w-full bg-surface rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-200",
                                tf.status === "complete" && "bg-success",
                                tf.status === "error" && "bg-error",
                                tf.status === "cancelled" && "bg-warning",
                                tf.status === "paused" && "bg-warning/70",
                                tf.status === "sending" &&
                                  "bg-gradient-to-r from-primary to-accent",
                                tf.status === "receiving" &&
                                  "bg-gradient-to-r from-accent to-primary"
                              )}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-[11px] text-muted mt-1.5">
                            <span>{percent}%</span>
                            {isActive && tf.speed > 0 && (
                              <span>ETA: {formatEta(remaining, tf.speed)}</span>
                            )}
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

        {/* ──────────── Right: Peers ──────────── */}
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
                <p className="text-xs text-muted font-mono">
                  {clientId.substring(0, 8)}
                </p>
              </div>
            </div>

            {peers.length === 0 ? (
              <div className="text-center py-8 text-muted text-sm px-4">
                Share the room code{" "}
                <span className="font-bold text-foreground">{roomId}</span> with
                others to let them join.
              </div>
            ) : (
              peers.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 p-3 rounded-xl bg-background border border-border"
                >
                  <div className="w-10 h-10 rounded-full bg-surface flex items-center justify-center font-bold text-muted">
                    {p.name.substring(0, 1)}
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-sm flex items-center gap-2">
                      {p.name}
                      {p.connected && (
                        <CheckCircle2 size={14} className="text-success" />
                      )}
                    </p>
                    <p className="text-xs text-muted flex items-center gap-1">
                      <span
                        className={cn(
                          "w-2 h-2 rounded-full",
                          p.connected ? "bg-success" : "bg-warning animate-pulse"
                        )}
                      />
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
