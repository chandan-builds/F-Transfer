export function GitStamp() {
  return (
    <div className="fixed bottom-4 right-4 z-40">
      <a 
        href="https://github.com/chandan-builds" 
        target="_blank" 
        rel="noopener noreferrer"
        className="flex items-center gap-2 glass px-4 py-2 rounded-full hover:scale-105 transition-transform group text-sm"
      >
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
        <span className="text-muted group-hover:text-foreground transition-colors">
          chandan-builds
        </span>
      </a>
    </div>
  );
}
