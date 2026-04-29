import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles } from "lucide-react";

const LOGO_URL = `${import.meta.env.BASE_URL}favicon.svg`;

// Welcome splash now appears on every launch (no session gate) and runs
// long enough to feel cinematic.
const SPLASH_MIN_MS = 3000;

export function SplashScreen({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState<boolean>(true);

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setShow(false), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, [show]);

  return (
    <>
      <AnimatePresence>
        {show && (
          <motion.div
            key="splash"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.05, filter: "blur(8px)" }}
            transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden"
            style={{
              background:
                "radial-gradient(ellipse at 30% 20%, hsl(150 40% 96%) 0%, hsl(0 0% 100%) 45%, hsl(25 50% 97%) 100%)",
            }}
          >
            {[...Array(18)].map((_, i) => (
              <motion.div
                key={i}
                className="absolute rounded-full"
                style={{
                  width: 6 + (i % 3) * 5,
                  height: 6 + (i % 3) * 5,
                  background:
                    i % 2
                      ? "hsl(150 50% 55% / 0.45)"
                      : "hsl(140 70% 50% / 0.45)",
                  left: `${(i * 83) % 100}%`,
                  top: `${(i * 47) % 100}%`,
                }}
                initial={{ opacity: 0, scale: 0 }}
                animate={{
                  opacity: [0, 1, 0],
                  scale: [0, 1, 0.6],
                  y: [0, -60 - i * 6, -130],
                }}
                transition={{
                  duration: 2.6,
                  delay: i * 0.06,
                  ease: "easeOut",
                }}
              />
            ))}

            <motion.div
              className="absolute rounded-full"
              style={{
                width: 360,
                height: 360,
                background:
                  "radial-gradient(circle, hsl(150 60% 55% / 0.20) 0%, transparent 65%)",
                filter: "blur(12px)",
              }}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: [0.4, 1.25, 1.05], opacity: [0, 0.95, 0.75] }}
              transition={{ duration: 2.2, ease: "easeOut" }}
            />

            <div className="relative flex flex-col items-center gap-6">
              <motion.div
                initial={{ scale: 0.4, opacity: 0, rotate: -25 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                transition={{
                  duration: 1.1,
                  ease: [0.22, 1.4, 0.36, 1],
                }}
                className="relative"
              >
                <motion.div
                  className="absolute -inset-4 rounded-3xl"
                  style={{
                    background:
                      "conic-gradient(from 0deg, hsl(150 60% 55%), hsl(95 65% 50%), hsl(160 60% 40%), hsl(150 60% 55%))",
                    filter: "blur(16px)",
                    opacity: 0.5,
                  }}
                  animate={{ rotate: 360 }}
                  transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
                />
                <motion.div
                  className="relative w-32 h-32 rounded-3xl shadow-2xl overflow-hidden flex items-center justify-center"
                  animate={{ scale: [1, 1.04, 1] }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <img
                    src={LOGO_URL}
                    alt="AnkiGen"
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                  <motion.div
                    className="absolute -top-1.5 -right-1.5"
                    initial={{ scale: 0, rotate: -45 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ delay: 0.85, duration: 0.7, ease: "backOut" }}
                  >
                    <Sparkles className="h-6 w-6 text-emerald-500 fill-emerald-500/30 drop-shadow" />
                  </motion.div>
                </motion.div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.55, duration: 0.85 }}
                className="text-center"
              >
                <h1 className="font-serif text-5xl font-bold tracking-tight bg-gradient-to-br from-primary via-emerald-500 to-lime-500 bg-clip-text text-transparent">
                  Welcome to AnkiGen
                </h1>
                <motion.p
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 1.0, duration: 0.7 }}
                  className="mt-3 text-base text-muted-foreground tracking-wide"
                >
                  Smart flashcards, instantly.
                </motion.p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, scaleX: 0 }}
                animate={{ opacity: 1, scaleX: 1 }}
                transition={{ delay: 0.7, duration: 1.8, ease: "easeInOut" }}
                style={{ originX: 0 }}
                className="h-[3px] w-48 rounded-full overflow-hidden bg-muted"
              >
                <motion.div
                  className="h-full w-1/3 bg-gradient-to-r from-primary to-lime-500 rounded-full"
                  animate={{ x: ["-100%", "300%"] }}
                  transition={{
                    duration: 1.8,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ visibility: show ? "hidden" : "visible" }}>
        {children}
      </div>
    </>
  );
}
