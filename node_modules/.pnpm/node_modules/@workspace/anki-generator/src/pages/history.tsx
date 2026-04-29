import { Link } from "wouter";
import { useListGenerations, useClearGenerations, getListGenerationsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  ArrowLeft, Trash2, History as HistoryIcon, CheckCircle2, XCircle, Ban,
  Clock, Layers, FileText, Sparkles, Type, Image as ImageIcon,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> Success
      </Badge>
    );
  }
  if (status === "cancelled") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <Ban className="h-3 w-3" /> Cancelled
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 border-destructive/30 bg-destructive/10 text-destructive">
      <XCircle className="h-3 w-3" /> Error
    </Badge>
  );
}

function DeckTypeIcon({ type }: { type: string }) {
  if (type === "text") return <Type className="h-3 w-3" />;
  if (type === "visual") return <ImageIcon className="h-3 w-3" />;
  return <Layers className="h-3 w-3" />;
}

export default function History() {
  const { data: generations, isLoading } = useListGenerations({ limit: 200 });
  const clearMutation = useClearGenerations();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);

  const stats = useMemo(() => {
    const list = generations ?? [];
    const successes = list.filter(g => g.status === "success");
    const totalCards = successes.reduce((sum, g) => sum + g.cardsGenerated, 0);
    const avgDuration = successes.length > 0
      ? successes.reduce((sum, g) => sum + g.durationMs, 0) / successes.length
      : 0;
    return {
      total: list.length,
      successes: successes.length,
      totalCards,
      avgDuration,
    };
  }, [generations]);

  const handleClear = async () => {
    try {
      await clearMutation.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: getListGenerationsQueryKey() });
      toast({ title: "History cleared" });
    } catch {
      toast({ title: "Failed to clear history", variant: "destructive" });
    } finally {
      setConfirmClear(false);
    }
  };

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link href="/decks" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-2">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to decks
          </Link>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center">
              <HistoryIcon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-serif font-bold leading-tight">Generation History</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Past AI runs with timing and card counts.
              </p>
            </div>
          </div>
        </div>
        {(generations?.length ?? 0) > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {(generations?.length ?? 0) > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-border/60 bg-card/60 p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              <Sparkles className="h-3 w-3" /> Runs
            </div>
            <div className="mt-1 text-2xl font-serif font-bold">{stats.total}</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-card/60 p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Successful
            </div>
            <div className="mt-1 text-2xl font-serif font-bold">{stats.successes}</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-card/60 p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              <Layers className="h-3 w-3 text-violet-500" /> Cards made
            </div>
            <div className="mt-1 text-2xl font-serif font-bold">{stats.totalCards}</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-card/60 p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              <Clock className="h-3 w-3 text-blue-500" /> Avg duration
            </div>
            <div className="mt-1 text-2xl font-serif font-bold">{formatDuration(stats.avgDuration)}</div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : (generations?.length ?? 0) === 0 ? (
        <div className="text-center py-20 px-6 border-2 border-dashed border-border/60 rounded-2xl bg-gradient-to-b from-card/60 to-muted/20">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/20 flex items-center justify-center mb-5">
            <HistoryIcon className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-xl font-serif font-semibold mb-1.5">No generations yet</h3>
          <p className="text-muted-foreground text-sm mb-6 max-w-sm mx-auto">Generate your first deck to start building history.</p>
          <Link href="/decks">
            <Button className="gap-2"><Sparkles className="h-4 w-4" />Go to decks</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {(generations ?? []).map(g => {
            const startedDate = new Date(g.startedAt);
            return (
              <Card key={g.id} className="border-border/60 bg-card/60">
                <CardContent className="p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-sm truncate">{g.deckName}</h3>
                        <StatusBadge status={g.status} />
                        <Badge variant="outline" className="gap-1 text-[10px] font-normal capitalize">
                          <DeckTypeIcon type={g.deckType} />
                          {g.deckType}
                        </Badge>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                        <span className="flex items-center gap-1" title={format(startedDate, "PPpp")}>
                          {formatDistanceToNow(startedDate, { addSuffix: true })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(g.durationMs)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Layers className="h-3 w-3" />
                          {g.cardsGenerated} {g.cardsGenerated === 1 ? "card" : "cards"}
                        </span>
                        {g.pageCount > 0 && (
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            {g.pageCount} {g.pageCount === 1 ? "page" : "pages"}
                          </span>
                        )}
                      </div>
                      {g.customPrompt && (
                        <div className="mt-2 text-[11px] text-muted-foreground bg-muted/40 rounded-md px-2 py-1.5 border border-border/40 line-clamp-2">
                          <span className="font-medium text-foreground/70">Prompt:</span> {g.customPrompt}
                        </div>
                      )}
                      {g.errorMessage && g.status === "error" && (
                        <div className="mt-2 text-[11px] text-destructive bg-destructive/10 rounded-md px-2 py-1.5 border border-destructive/20 line-clamp-2">
                          {g.errorMessage}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear all history?</DialogTitle>
            <DialogDescription>
              This deletes the log of past generation runs. Your decks and cards are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)} disabled={clearMutation.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleClear} disabled={clearMutation.isPending}>
              {clearMutation.isPending ? "Clearing…" : "Clear history"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
