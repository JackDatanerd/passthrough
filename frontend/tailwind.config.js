/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}'
  ],
  theme: {
    extend: {
      // Used by <Toast>; the class was referenced but never defined.
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        // <TypedText>'s caret: a hard on/off blink, then it fades away once the line is done.
        'caret-blink': { '50%': { opacity: '0' } },
        'caret-out': { to: { opacity: '0' } },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'caret-blink': 'caret-blink 0.8s steps(1) infinite',
        'caret-done': 'caret-blink 0.8s steps(1) 3, caret-out 0.3s ease 2.4s forwards',
      },
      // Homepage rebrand: the logo wordmark and the hero headline use Bricolage Grotesque (self-hosted, see index.css).
      fontFamily: {
        display: ['"Bricolage Grotesque Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
      },
      colors: { ink: { DEFAULT: '#0A1530', 2: '#2B3A5E' }, paper: '#F6F7FB' },
    },
  },
  plugins: []
}
