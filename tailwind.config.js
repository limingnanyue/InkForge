/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    container: { center: true },
    extend: {
      colors: {
        ink: {
          900: '#0E0B08', 800: '#14100B', 700: '#1A1410', 600: '#241A14',
          500: '#2E2519', 400: '#3A2E1F', 300: '#4A3A28',
        },
        paper: { DEFAULT: '#F5E6C8', dim: '#D8C39A', mute: '#8A7A5A' },
        amber: {
          DEFAULT: '#D4A534', bright: '#E8BE4A', mid: '#C8961E', deep: '#8B6914',
        },
        cinnabar: '#B23A48',
        celadon: '#5A8A6A',
      },
      fontFamily: {
        display: ['Fraunces', 'Noto Serif SC', 'Georgia', 'serif'],
        sans: ['Manrope', 'Noto Sans SC', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      animation: {
        'blur-in': 'blur-in 0.9s cubic-bezier(0.22,1,0.36,1) both',
        'fade-up': 'fade-up 0.5s ease-out both',
        'fade-in': 'fade-in 0.4s ease-out both',
        'pop-in': 'pop-in 0.3s ease-out both',
        shimmer: 'shimmer 2s linear infinite',
      },
    },
  },
  plugins: [],
};
