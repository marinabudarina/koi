import { useCallback, useEffect, useRef, useState } from "react";

const MUSIC_SRC = `${import.meta.env.BASE_URL}audio/koi-ambient.mp3`;
const PLOP_SRC = `${import.meta.env.BASE_URL}audio/coin-plop.mp3`;
const MUSIC_VOLUME = 0.45;

/**
 * Ambient pond music + the coin "plop".
 *
 * Browsers refuse to start audio before the first user gesture, so the music waits
 * for the first click on the hero and starts then — unless the visitor has already
 * switched it off with the speaker button. The button always wins.
 */
export function useSound() {
  const music = useRef<HTMLAudioElement | null>(null);
  const fadeRaf = useRef(0);
  const [on, setOn] = useState(false);
  // null = no explicit choice yet (auto-start on first click), true/false = chosen
  const pref = useRef<boolean | null>(null);

  useEffect(() => {
    const a = new Audio(MUSIC_SRC);
    a.loop = true;
    a.preload = "auto";
    a.volume = 0;
    music.current = a;
    return () => {
      cancelAnimationFrame(fadeRaf.current);
      a.pause();
      a.src = "";
      music.current = null;
    };
  }, []);

  const fadeTo = useCallback((target: number, ms: number, then?: () => void) => {
    const a = music.current;
    if (!a) return;
    cancelAnimationFrame(fadeRaf.current);
    const from = a.volume;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      a.volume = from + (target - from) * k;
      if (k < 1) fadeRaf.current = requestAnimationFrame(step);
      else then?.();
    };
    fadeRaf.current = requestAnimationFrame(step);
  }, []);

  const start = useCallback(() => {
    const a = music.current;
    if (!a) return;
    a.play()
      .then(() => {
        setOn(true);
        fadeTo(MUSIC_VOLUME, 1800);
      })
      .catch(() => {
        // autoplay blocked: stay silent until the visitor presses the button
        setOn(false);
      });
  }, [fadeTo]);

  const stop = useCallback(() => {
    const a = music.current;
    if (!a) return;
    setOn(false);
    fadeTo(0, 500, () => a.pause());
  }, [fadeTo]);

  const toggle = useCallback(() => {
    const next = !on;
    pref.current = next;
    if (next) start();
    else stop();
  }, [on, start, stop]);

  /** Called on the first gesture inside the hero: starts the music unless it was switched off. */
  const onFirstGesture = useCallback(() => {
    if (pref.current === null && !on) {
      pref.current = true;
      start();
    }
  }, [on, start]);

  const plop = useCallback(() => {
    if (!on) return;
    const s = new Audio(PLOP_SRC);
    s.volume = 0.55 + Math.random() * 0.25;
    s.playbackRate = 0.9 + Math.random() * 0.25;
    s.play().catch(() => {
      // a blocked effect is not worth surfacing
    });
  }, [on]);

  return { on, toggle, onFirstGesture, plop };
}
