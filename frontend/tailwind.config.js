/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}'
  ],
  theme: {
    extend: {
      // Used by <Toast>; the class was referenced but never defined.
      keyframes: { 'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } } },
      animation: { 'fade-in': 'fade-in 0.2s ease-out' },
    },
  },
  plugins: []
}
