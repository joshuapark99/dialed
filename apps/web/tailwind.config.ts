import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17211d",
        canvas: "#f4f4f0",
        panel: "#ffffff",
        line: "#d9ddd8",
        muted: "#66716b",
        leaf: "#217158",
        coral: "#d85f43",
        sky: "#3e718a",
        sun: "#dda63a",
      },
      boxShadow: {
        panel:
          "0 1px 2px rgb(23 33 29 / 0.06), 0 8px 30px rgb(23 33 29 / 0.06)",
      },
    },
  },
  plugins: [],
} satisfies Config;
