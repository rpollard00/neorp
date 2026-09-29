export const PALETTE_NAMES = [
  "dusk",
  "dawn",
  "day",
  "night",
  "haze",
  "ember",
  "sea",
  "storm",
  "frost",
  "bloom",
  "desert",
] as const;

export type PaletteName = (typeof PALETTE_NAMES)[number];

export type Palette = {
  sky: { top: string; middle: string; horizon: string };
  sun: string;
  hills: { back: string; front: string };
  stars: boolean;
};

export const STAR_COLOUR = "#d9dcf0";

export const PALETTES = {
  dusk: {
    sky: { top: "#23264f", middle: "#6b4f86", horizon: "#e3907f" },
    sun: "#f7d58e",
    hills: { back: "#5b4271", front: "#271d3b" },
    stars: false,
  },
  dawn: {
    sky: { top: "#7a6a9a", middle: "#e9a9a0", horizon: "#f6d6b0" },
    sun: "#fff4dc",
    hills: { back: "#b0798c", front: "#6a466b" },
    stars: false,
  },
  day: {
    sky: { top: "#5f97b3", middle: "#a9d0dc", horizon: "#eef0e6" },
    sun: "#f2b27a",
    hills: { back: "#6f9199", front: "#355560" },
    stars: false,
  },
  night: {
    sky: { top: "#0e1130", middle: "#1d2753", horizon: "#374777" },
    sun: "#ece6cf",
    hills: { back: "#243058", front: "#0b0d22" },
    stars: true,
  },
  haze: {
    sky: { top: "#8c8499", middle: "#c9c0cf", horizon: "#ecdcc9" },
    sun: "#f6efe2",
    hills: { back: "#7a7188", front: "#4e4860" },
    stars: false,
  },
  ember: {
    sky: { top: "#2a1020", middle: "#8a2d2a", horizon: "#f08a3c" },
    sun: "#ffe08a",
    hills: { back: "#4a1a26", front: "#1a0a12" },
    stars: false,
  },
  sea: {
    sky: { top: "#0f3a4a", middle: "#2f8a8c", horizon: "#bfe6d6" },
    sun: "#fff1c9",
    hills: { back: "#1f5d63", front: "#0b2a33" },
    stars: false,
  },
  storm: {
    sky: { top: "#2b2f3a", middle: "#56606e", horizon: "#a9b0a0" },
    sun: "#e8e36a",
    hills: { back: "#3a4250", front: "#1a1e26" },
    stars: false,
  },
  frost: {
    sky: { top: "#4a6a9a", middle: "#a9c4e0", horizon: "#eef3f6" },
    sun: "#ffffff",
    hills: { back: "#8aa3bf", front: "#4a6284" },
    stars: false,
  },
  bloom: {
    sky: { top: "#6e4a7e", middle: "#e59ab5", horizon: "#fbe1d6" },
    sun: "#fff6e8",
    hills: { back: "#5f8a6a", front: "#2f4f3e" },
    stars: false,
  },
  desert: {
    sky: { top: "#3b2a4a", middle: "#c86a4a", horizon: "#f3c58a" },
    sun: "#fff0c0",
    hills: { back: "#a4553a", front: "#5a2a22" },
    stars: false,
  },
} satisfies Record<PaletteName, Palette>;
