import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        midnight: "#070A0F",
        slatecard: "#0F1622",
        cyan: {
          DEFAULT: "#00F5FF",
          dim: "#00F5FF33",
        },
        emerald: {
          DEFAULT: "#10B981",
          dim: "#10B98133",
        },
      },
      boxShadow: {
        glow: "0 0 40px rgba(0, 245, 255, 0.12)",
      },
      fontFamily: {
        sans: ["var(--font-ibm-plex)", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-ibm-mono)", "ui-monospace", "SFMono-Regular"],
      },
    },
  },
  plugins: [],
};

export default config;
