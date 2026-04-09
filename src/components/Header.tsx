import Link from "next/link";
import { Copy, Plus, Activity } from "lucide-react";

export function Header({ roomCode }: { roomCode?: string }) {
  return (
    <header className="border-b border-border/50 bg-background/80 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <Link href="/" className="font-heading font-bold text-xl flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
            <Activity size={20} />
          </div>
          F-Transfer
        </Link>
        
        {roomCode && (
          <div className="flex items-center gap-3 glass px-4 py-1.5 rounded-full">
            <span className="text-sm text-muted">Room Code:</span>
            <span className="font-mono font-bold tracking-widest text-primary">{roomCode}</span>
            <button 
              onClick={() => navigator.clipboard.writeText(roomCode)}
              className="text-muted hover:text-foreground transition-colors"
              title="Copy Room Code"
            >
              <Copy size={16} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
