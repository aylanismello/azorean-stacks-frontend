import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0a0a0a",
          1: "#111111",
          2: "#1a1a1a",
          3: "#242424",
          4: "#2e2e2e",
        },
        accent: {
          DEFAULT: "#d4a053",
          dim: "#a67c3d",
          bright: "#e8b96a",
        },
        muted: "#666666",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "SF Mono", "monospace"],
      },
      maxWidth: {
        card: "500px",
      },
    },
  },
  plugins: [],
};

export default config;
