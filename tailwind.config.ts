import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        mist: "#F4F7FB",
        line: "#D9E2EC",
        action: "#2563EB",
        coral: "#F97316",
        teal: "#0F766E"
      },
      boxShadow: {
        soft: "0 18px 50px rgba(17, 24, 39, 0.10)"
      }
    }
  },
  plugins: []
};

export default config;
