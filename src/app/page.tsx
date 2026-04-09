"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { GitStamp } from "@/components/GitStamp";
import { ArrowRight, Wifi, Shield, Zap } from "lucide-react";
import { motion } from "framer-motion";

export default function Home() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");

  const handleCreateRoom = () => {
    // Generate a random 6-character hex code
    const code = Math.random().toString(16).substring(2, 8).toUpperCase();
    router.push(`/room/${code}`);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (joinCode.trim().length >= 6) {
      router.push(`/room/${joinCode.trim().toUpperCase()}`);
    }
  };

  return (
    <main className="min-h-screen flex flex-col relative overflow-hidden">
      <Header />
      
      {/* Abstract Background Elements */}
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-1/2 -right-1/4 w-[1000px] h-[1000px] rounded-full bg-primary/20 blur-[120px] opacity-50" />
        <div className="absolute -bottom-1/2 -left-1/4 w-[800px] h-[800px] rounded-full bg-accent/20 blur-[120px] opacity-50" />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-4 max-w-5xl mx-auto w-full text-center">
        <motion.h1 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-5xl md:text-7xl font-bold font-heading mb-6 tracking-tight"
        >
          Share Files <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Instantly</span>
        </motion.h1>
        
        <motion.p 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-lg md:text-xl text-muted max-w-2xl mb-12"
        >
          No servers. No storage limits. Pure P2P transfer over your local network at maximum Wi-Fi speed.
        </motion.p>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="glass p-8 rounded-2xl w-full max-w-md mx-auto space-y-8"
        >
          <div>
            <button
              onClick={handleCreateRoom}
              className="w-full py-4 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-lg shadow-lg hover:shadow-primary/25 transition-all flex items-center justify-center gap-2 group"
            >
              Create New Room
              <ArrowRight className="group-hover:translate-x-1 transition-transform" />
            </button>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border/50"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-surface text-muted">Or join existing</span>
            </div>
          </div>

          <form onSubmit={handleJoinRoom} className="space-y-4">
            <input
              type="text"
              placeholder="Enter Room Code (e.g. A1B2C3)"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              maxLength={6}
              className="w-full text-center uppercase tracking-widest font-mono text-xl py-4 bg-background border border-border rounded-xl focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            />
            <button
              type="submit"
              disabled={joinCode.length < 6}
              className="w-full py-4 rounded-xl bg-secondary hover:bg-secondary/80 text-secondary-foreground font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Join Room
            </button>
          </form>
        </motion.div>

        {/* Feature Highlights display */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 text-left w-full"
        >
          <div className="glass p-6 rounded-xl flex items-start gap-4">
            <div className="p-3 bg-primary/20 text-primary rounded-lg">
              <Zap size={24} />
            </div>
            <div>
              <h3 className="font-bold text-lg mb-1">Max Speed</h3>
              <p className="text-muted text-sm">Transfers happen on your local network bypassing internet throttles.</p>
            </div>
          </div>
          <div className="glass p-6 rounded-xl flex items-start gap-4">
            <div className="p-3 bg-success/20 text-success rounded-lg">
              <Wifi size={24} />
            </div>
            <div>
              <h3 className="font-bold text-lg mb-1">LAN Only</h3>
              <p className="text-muted text-sm">WebRTC DataChannels configured exclusively for Wi-Fi/LAN peers.</p>
            </div>
          </div>
          <div className="glass p-6 rounded-xl flex items-start gap-4">
            <div className="p-3 bg-accent/20 text-accent rounded-lg">
              <Shield size={24} />
            </div>
            <div>
              <h3 className="font-bold text-lg mb-1">Secure & Private</h3>
              <p className="text-muted text-sm">End-to-End DTLS encryption. No files are ever saved on any server.</p>
            </div>
          </div>
        </motion.div>
      </div>

      <GitStamp />
    </main>
  );
}
