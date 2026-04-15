/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        curve: {
          50: '#fdf6f3',
          100: '#fae8e1',
          200: '#f5cfc2',
          300: '#edab96',
          400: '#e28264',
          500: '#d4633f',
          600: '#c04e30',
          700: '#a03d27',
          800: '#843525',
          900: '#6e3024',
          950: '#3b160f',
        },
        sand: {
          50: '#faf9f7',
          100: '#f3f1ec',
          200: '#e6e1d8',
          300: '#d4ccbd',
          400: '#bfb39e',
          500: '#b0a089',
          600: '#a08e77',
          700: '#857563',
          800: '#6d6054',
          900: '#5a5046',
          950: '#2f2a24',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        handwritten: [
          'Caveat',
          'Segoe Script',
          'Comic Sans MS',
          'cursive',
        ],
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        // Distribution bar segments (`/categories` §9.8 #5). Each
        // segment starts at scaleX(0) with origin-left and animates
        // to scaleX(1), producing a left-to-right grow cascade when
        // combined with a per-segment `animationDelay`.
        'grow-x': {
          '0%': { transform: 'scaleX(0)' },
          '100%': { transform: 'scaleX(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.4s ease-out',
        'fade-in-up': 'fade-in-up 0.5s ease-out',
        'slide-in-right': 'slide-in-right 0.4s ease-out',
        'grow-x': 'grow-x 0.5s ease-out forwards',
      },
    },
  },
  plugins: [],
};
