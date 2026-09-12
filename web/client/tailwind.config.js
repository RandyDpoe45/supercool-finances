/**
 * SuperCool Finances — customer SPA theme.
 *
 * Dark, Spotify-inspired palette: near-black surfaces, a single green accent, and
 * high-contrast type. The palette is the app's design contract — restyling the whole
 * SPA is a change to these tokens plus the `@layer components` primitives in index.css.
 * (Each frontend keeps its own copy: the monorepo shares conventions, not code.)
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // These BEM variants are built at runtime (e.g. `badge--${status}`,
  // `direction--${direction}`), so the content scanner never sees the literal name and
  // would tree-shake the mapped rules out of the production bundle. Safelist them so the
  // status/direction colours always ship. (cooling-off--* are static literals, retained.)
  safelist: ['badge--active', 'badge--frozen', 'direction--in', 'direction--out'],
  theme: {
    extend: {
      colors: {
        base: '#121212',
        surface: { DEFAULT: '#181818', raised: '#282828', input: '#2a2a2a' },
        accent: { DEFAULT: '#1db954', hover: '#1ed760', press: '#169c46' },
        ink: { DEFAULT: '#ffffff', muted: '#b3b3b3', subtle: '#7a7a7a' },
        line: 'rgba(255, 255, 255, 0.10)',
        danger: '#f6465d',
        warn: '#f0a935',
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { card: '0.75rem' },
      boxShadow: { card: '0 8px 24px rgba(0, 0, 0, 0.5)' },
    },
  },
  plugins: [],
};
