import localFont from "next/font/local";

export const notoSansJP = localFont({
  src: "../fonts/NotoSansJP-Variable.ttf",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-noto-sans-jp",
  preload: true,
});

export const notoSerifJP = localFont({
  src: "../fonts/NotoSerifJP-Variable.ttf",
  weight: "200 900",
  style: "normal",
  display: "swap",
  variable: "--font-noto-serif-jp",
  preload: true,
});

export const notoSansMono = localFont({
  src: "../fonts/NotoSansMono-Variable.ttf",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-noto-sans-mono",
  preload: false,
});
