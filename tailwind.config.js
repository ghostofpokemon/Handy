/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        text: "var(--color-text)",
        background: "var(--color-background)",
        "logo-primary": "var(--color-logo-primary)",
        "logo-stroke": "var(--color-logo-stroke)",
        "text-stroke": "var(--color-text-stroke)",
        primary: "var(--color-logo-primary)",
        "primary-foreground": "#1a0510", // Dark text on pink for contrast? Or white? #faa2ca is light.
        secondary: "var(--color-text-stroke)", // Using text-stroke (light gray) for secondary backgrounds?
        "secondary-foreground": "var(--color-text)",
        muted: "var(--color-mid-gray)",
        "muted-foreground": "var(--color-mid-gray)",
        border: "var(--color-logo-stroke)",
      },
    },
  },
  plugins: [],
};
