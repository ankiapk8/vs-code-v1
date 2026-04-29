import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

export function useOnlineStatus() {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-800 dark:text-amber-300 px-4 py-1.5 text-xs flex items-center justify-center gap-2 animate-in slide-in-from-top duration-300">
      <WifiOff className="h-3.5 w-3.5" />
      <span>
        <strong>Offline mode</strong> — showing your saved decks. New
        generation, exports and AI features need internet.
      </span>
    </div>
  );
}

export function OfflineBadge() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-semibold px-2 py-0.5 border border-amber-500/30">
      <WifiOff className="h-2.5 w-2.5" />
      OFFLINE
    </span>
  );
}
