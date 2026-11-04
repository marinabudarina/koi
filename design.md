# Koi Hero — design direction

Source: Figma "Portfolio Budarina" (node 694-15776), reproduced from the exported frame.

- **Background**: flat `#9C0400`, no gradient, no grain.
- **Headline**: "CREATE / DAILY" in Instrument Serif (high-contrast Didone look), white, uppercase,
  `25vw` (31vw on mobile), letter-spacing −0.045em, line-height 0.78; DAILY indented 0.4em.
- **Labels / UI text**: JetBrains Mono 500, uppercase, white ("MARINA / BUDARINA" left of DAILY,
  "INTERFACE / DESIGN" right-bottom of DAILY; hidden below 640px).
- **Controls**: top-left white square (asterisk icon, `#202020`); top-right white group with
  hamburger + `#D7D4D4` CONTACT pill; bottom-center `#860704` ABOUT button. Radius ~12px.
- **Layers**: text z-2 → koi WebGL canvas z-3 (fish swim over the type) → ABOUT z-4 →
  ripple output canvas z-10 (click → water ripple glints; full refraction when the browser
  supports HTML-in-canvas).
- **Motion**: letter stagger on load (motion), UI fades in after ~1s.
