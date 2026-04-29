import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { SplashScreen } from "@/components/splash-screen";
import { PageTransition } from "@/components/page-transition";
import { ClickRipple } from "@/components/click-ripple";
import { OfflineBanner } from "@/components/offline-indicator";
import { UpdateBanner } from "@/components/update-banner";

import Dashboard from "@/pages/dashboard";
import Generate from "@/pages/generate";
import Decks from "@/pages/decks";
import DeckDetail from "@/pages/deck-detail";
import History from "@/pages/history";
import NotFound from "@/pages/not-found";

const ONE_WEEK = 1000 * 60 * 60 * 24 * 7;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: ONE_WEEK,
      staleTime: 1000 * 60 * 5,
      retry: (failureCount, err) => {
        if (typeof navigator !== "undefined" && !navigator.onLine) return false;
        return failureCount < 2;
      },
      networkMode: "offlineFirst",
    },
    mutations: {
      networkMode: "offlineFirst",
    },
  },
});

const persister = createSyncStoragePersister({
  storage: typeof window === "undefined" ? undefined : window.localStorage,
  key: "ankigen-cache-v1",
  throttleTime: 1000,
});

function Router() {
  return (
    <Layout>
      <PageTransition>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/generate" component={Generate} />
          <Route path="/decks" component={Decks} />
          <Route path="/decks/:id" component={DeckDetail} />
          <Route path="/history" component={History} />
          <Route component={NotFound} />
        </Switch>
      </PageTransition>
    </Layout>
  );
}

function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: ONE_WEEK,
        buster: "v1",
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => {
            const key = q.queryKey?.[0];
            if (typeof key !== "string") return false;
            return (
              key.includes("/decks") ||
              key.includes("/cards") ||
              key.includes("listDecks") ||
              key.includes("getDeck") ||
              key.includes("listDeckCards")
            );
          },
        },
      }}
    >
      <TooltipProvider>
        <OfflineBanner />
        <UpdateBanner />
        <SplashScreen>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </SplashScreen>
        <ClickRipple />
        <Toaster />
      </TooltipProvider>
    </PersistQueryClientProvider>
  );
}

export default App;
