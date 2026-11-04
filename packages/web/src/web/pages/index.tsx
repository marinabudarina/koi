import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { KoiCanvas, MAX_FISH } from "../components/koi-canvas";
import { Ripple } from "../components/ripple";
import { useSound } from "../components/use-sound";

const LINE_ONE = "CREATE";
const LINE_TWO = "DAILY";
const LINKS = {
  instagram: "https://www.instagram.com/marina_uiux/",
  contact: "https://budarina.design/links",
  works: "https://works.budarina.design",
  education: "https://budarina.design",
  studio: "https://studio.budarina.design",
};

const letter = {
  hidden: { y: "110%", opacity: 0 },
  show: (i: number) => ({
    y: "0%",
    opacity: 1,
    transition: { delay: 0.15 + i * 0.045, duration: 0.9, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

function Word({ text, offset = 0, className = "" }: { text: string; offset?: number; className?: string }) {
  return (
    <span className={`word block ${className}`}>
      {text.split("").map((ch, i) => (
        <motion.span
          key={i}
          custom={offset + i}
          variants={letter}
          initial="hidden"
          animate="show"
          className="inline-block will-change-transform"
        >
          {ch}
        </motion.span>
      ))}
    </span>
  );
}

const fade = (delay: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { delay, duration: 0.7, ease: "easeOut" as const },
});

function AsteriskIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[42%] w-[42%]" fill="currentColor" aria-hidden="true">
      <path d="M12 12 4.4 5.6a1.9 1.9 0 0 1 1.2-3.3c1.6 0 3.2 2.1 6.4 6.3 3.2-4.2 4.8-6.3 6.4-6.3a1.9 1.9 0 0 1 1.2 3.3L12 12l7.6 6.4a1.9 1.9 0 0 1-1.2 3.3c-1.6 0-3.2-2.1-6.4-6.3-3.2 4.2-4.8 6.3-6.4 6.3a1.9 1.9 0 0 1-1.2-3.3L12 12Z" />
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[40%] w-[40%]" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      {open ? <path d="M5 5l14 14M19 5 5 19" /> : <path d="M3 6h18M3 12h18M3 18h18" />}
    </svg>
  );
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[40%] w-[40%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5H4Z" fill="currentColor" stroke="none" />
      {on ? (
        <>
          <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
          <path d="M18.3 6.5a8 8 0 0 1 0 11" />
        </>
      ) : (
        <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
      )}
    </svg>
  );
}

type Panel = "menu" | "about" | null;

const MENU = [
  { label: "Works", href: LINKS.works },
  { label: "Education", href: LINKS.education },
  { label: "Studio services", href: LINKS.studio },
  { label: "Contact", href: LINKS.contact },
];

function Overlay({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, onClose]);

  return (
    <AnimatePresence>
      {panel && (
        <motion.div
          key={panel}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="absolute inset-0 z-[20] flex items-center justify-center bg-[#9c0400]/92 backdrop-blur-sm"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute inset-0 cursor-default"
          />
          <div className="mono overlay-body relative w-full text-white">
            {panel === "menu" ? (
              <ul className="menu-list flex flex-col">
                {MENU.map((item, i) => (
                  <motion.li
                    key={item.label}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 + i * 0.06, duration: 0.45, ease: "easeOut" }}
                  >
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                      onClick={onClose}
                      className="display menu-item inline-block leading-none transition hover:translate-x-[0.05em] hover:opacity-80"
                    >
                      {item.label}
                    </a>
                  </motion.li>
                ))}
              </ul>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08, duration: 0.45, ease: "easeOut" }}
                className="about-body flex flex-col"
              >
                <p className="display about-title leading-none">About</p>
                <p className="about-text max-w-[40ch] leading-[1.5] normal-case">
                  Marina Budarina is an interface designer. She builds calm, considered digital
                  products — and keeps a daily practice of making something new. Based in Europe,
                  working with teams worldwide.
                </p>
                <a
                  href={LINKS.instagram}
                  target="_blank"
                  rel="noreferrer"
                  className="about-text underline underline-offset-[0.3em] opacity-80 hover:opacity-100"
                >
                  @marina_uiux
                </a>
              </motion.div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Index() {
  const [panel, setPanel] = useState<Panel>(null);
  const [fishCount, setFishCount] = useState(3);
  const close = () => setPanel(null);
  const sound = useSound();

  return (
    <main className="hero relative h-dvh min-h-[320px] w-full overflow-hidden select-none text-white">
      <Ripple
        amplitude={0.5}
        speed={0.65}
        wavelength={80}
        rings={2}
        decay={1}
        refraction={100}
        dispersion={0.5}
        shine={1.1}
        interval={0}
        trigger="click"
        style={{ position: "absolute", inset: 0 }}
      >
        <section
          data-koi-host
          className="relative h-full w-full overflow-hidden"
          onPointerDown={(e) => {
            // the first drop into the water also starts the pond music (browsers need a gesture)
            if (e.target instanceof Element && e.target.closest("button, a")) return;
            sound.onFirstGesture();
          }}
        >
          {/* top-left: asterisk / home */}
          <motion.a
            {...fade(1.0)}
            href="/"
            aria-label="Home"
            onClick={(e) => {
              e.preventDefault();
              close();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className="ui-btn absolute ui-tl z-[30] flex items-center justify-center bg-white text-[#202020] transition hover:bg-[#e9e6e6] active:scale-95"
          >
            <AsteriskIcon />
          </motion.a>

          {/* top-right: menu + contact */}
          <motion.div
            {...fade(1.05)}
            className="ui-group absolute ui-tr z-[30] flex items-center gap-[2px] bg-white p-[3px]"
          >
            <button
              type="button"
              aria-label={panel === "menu" ? "Close menu" : "Open menu"}
              aria-expanded={panel === "menu"}
              onClick={() => setPanel(panel === "menu" ? null : "menu")}
              className="ui-btn flex cursor-pointer items-center justify-center text-[#202020] transition hover:bg-[#e9e6e6] active:scale-95"
            >
              <MenuIcon open={panel === "menu"} />
            </button>
            <button
              type="button"
              aria-label={sound.on ? "Turn music off" : "Turn music on"}
              aria-pressed={sound.on}
              onClick={sound.toggle}
              className="ui-btn flex cursor-pointer items-center justify-center text-[#202020] transition hover:bg-[#e9e6e6] active:scale-95"
            >
              <SoundIcon on={sound.on} />
            </button>
            <a
              href={LINKS.contact}
              target="_blank"
              rel="noreferrer"
              className="ui-pill mono flex items-center justify-center bg-[#d7d4d4] text-[#202020] transition hover:bg-[#c9c5c5] active:scale-[0.97]"
            >
              CONTACT
            </a>
          </motion.div>

          {/* headline */}
          <div className="absolute inset-0 z-[2] flex items-center justify-center">
            <div className="display relative uppercase leading-[0.78]">
              <Word text={LINE_ONE} />
              <div className="-mt-[0.02em] pl-[0.4em]">
                <div className="relative inline-block">
                  <Word text={LINE_TWO} offset={LINE_ONE.length} />

                  {/* left of the D */}
                  <motion.p
                    {...fade(1.1)}
                    className="label mono absolute left-0 top-[9%] -translate-x-[106%] text-right"
                  >
                    MARINA
                    <br />
                    BUDARINA
                  </motion.p>

                  {/* tucked under the right arm of the Y */}
                  <motion.p
                    {...fade(1.2)}
                    className="label mono absolute bottom-[13%] left-[92%] text-left"
                  >
                    INTERFACE
                    <br />
                    DESIGN
                  </motion.p>
                </div>
              </div>
            </div>
          </div>

          {/* koi layer sits above the type; sparkles + dropped coins stay at the content level, under the fish */}
          <KoiCanvas
            className="absolute inset-0 z-[3] pointer-events-none"
            layerClassName="absolute inset-0 z-[2] pointer-events-none"
            onSplash={sound.plop}
            count={fishCount}
          />

          {/* bottom-left: fish counter (1..MAX_FISH, starts at 3 on every load) */}
          <motion.div
            {...fade(1.3)}
            aria-label="Number of fish"
            className="ui-about ui-count mono absolute ui-bl z-[30] flex items-center bg-black/30 text-white backdrop-blur-md"
          >
            <button
              type="button"
              aria-label="Fewer fish"
              disabled={fishCount <= 1}
              onClick={() => setFishCount((c) => Math.max(1, c - 1))}
              className="ui-count-btn flex h-full cursor-pointer items-center justify-center transition hover:bg-white/10 active:scale-95 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            >
              −
            </button>
            <span className="ui-count-label flex items-center justify-center tabular-nums" aria-live="polite">
              {fishCount} KOI
            </span>
            <button
              type="button"
              aria-label="More fish"
              disabled={fishCount >= MAX_FISH}
              onClick={() => setFishCount((c) => Math.min(MAX_FISH, c + 1))}
              className="ui-count-btn flex h-full cursor-pointer items-center justify-center transition hover:bg-white/10 active:scale-95 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            >
              +
            </button>
          </motion.div>

          {/* bottom: about */}
          <motion.button
            {...fade(1.3)}
            type="button"
            aria-expanded={panel === "about"}
            onClick={() => setPanel(panel === "about" ? null : "about")}
            className="ui-about mono absolute ui-br z-[30] flex cursor-pointer items-center justify-center bg-black/30 text-white backdrop-blur-md transition hover:bg-black/45 active:scale-95"
          >
            ABOUT
          </motion.button>

          <Overlay panel={panel} onClose={close} />
        </section>
      </Ripple>
    </main>
  );
}

export default Index;
