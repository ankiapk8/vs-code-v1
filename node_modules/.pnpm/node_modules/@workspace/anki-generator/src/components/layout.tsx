import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { BookOpen, LayoutDashboard, Library, Sparkles } from "lucide-react";
import { HeaderApkButton } from "@/components/header-apk-button";
import { ApkWelcomeBanner } from "@/components/apk-welcome-banner";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navLinks = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/decks", label: "Library", icon: Library },
  ];

  const generateActive = location === "/generate";

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center gap-1 sm:gap-2 px-3 sm:px-4 md:px-6 max-w-5xl mx-auto">
          <Link href="/" className="flex items-center gap-2 mr-1 sm:mr-2 md:mr-6 shrink-0">
            <BookOpen className="h-6 w-6 text-primary" />
            <span className="font-serif text-lg font-bold tracking-tight hidden sm:inline">AnkiGen</span>
          </Link>
          <nav className="flex items-center gap-0.5 sm:gap-1 min-w-0">
            {navLinks.map(({ href, label, icon: Icon }) => {
              const isActive = href === "/"
                ? location === "/"
                : location.startsWith(href);
              return (
                <Link key={href} href={href}>
                  <span
                    className={`flex items-center gap-1.5 px-2 sm:px-3 py-2 sm:py-1.5 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-foreground/60 hover:text-foreground hover:bg-muted"
                    }`}
                    aria-label={label}
                  >
                    <Icon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    <span className="hidden xs:inline sm:inline">{label}</span>
                  </span>
                </Link>
              );
            })}

            <Link href="/generate">
              <motion.span
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: "spring", stiffness: 400, damping: 22 }}
                className={`relative ml-0.5 sm:ml-1 inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 sm:py-1.5 rounded-md text-sm font-semibold overflow-hidden text-white shadow-sm shadow-primary/20 ${
                  generateActive ? "ring-2 ring-primary/40 ring-offset-1 ring-offset-background" : ""
                }`}
                style={{
                  background:
                    "linear-gradient(120deg, hsl(150 60% 45%) 0%, hsl(140 65% 42%) 50%, hsl(95 65% 45%) 100%)",
                }}
                aria-label="Generate flashcards"
              >
                <motion.span
                  aria-hidden
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.45) 50%, transparent 70%)",
                  }}
                  animate={{ x: ["-120%", "120%"] }}
                  transition={{
                    duration: 2.6,
                    repeat: Infinity,
                    ease: "easeInOut",
                    repeatDelay: 1.4,
                  }}
                />
                <motion.span
                  aria-hidden
                  className="relative inline-flex"
                  animate={{ rotate: [0, 14, -10, 0], scale: [1, 1.15, 1, 1] }}
                  transition={{
                    duration: 2.4,
                    repeat: Infinity,
                    ease: "easeInOut",
                    repeatDelay: 0.6,
                  }}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </motion.span>
                <span className="relative">Generate</span>
              </motion.span>
            </Link>
          </nav>
          <div className="ml-auto pl-2">
            <HeaderApkButton />
          </div>
        </div>
      </header>
      <main className="flex-1 flex flex-col w-full max-w-5xl mx-auto p-4 md:p-8">
        {children}
      </main>
      <ApkWelcomeBanner />
    </div>
  );
}
