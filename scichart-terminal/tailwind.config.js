/** @type {import('tailwindcss').Config} */

// Every colour resolves through a CSS custom property so that `data-theme` on
// <html> can swap the entire palette without touching a single component.
//
// The `rgb(var(--x) / <alpha-value>)` form is mandatory, not stylistic: the
// codebase relies on ~25 Tailwind alpha modifiers (bg-terminal-surface/50,
// border-terminal-border/50, bg-terminal-accent/10 …) and a bare var() breaks
// every one of them silently.
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        terminal: {
          // Surfaces & chrome
          bg: token('bg'),
          surface: token('surface'),
          panel: token('card'),
          card: token('card'),
          border: token('border'),
          'border-strong': token('border-strong'),

          // Brand
          accent: token('accent'),
          'accent-dim': token('accent-dim'),
          gold: token('gold'),

          // Type
          text: token('text'),
          'text-dim': token('text-dim'),

          // Semantic — directional. `green`/`red` are retained as aliases so the
          // existing `text-terminal-green` call sites keep resolving.
          green: token('bull'),
          red: token('bear'),
          bull: token('bull'),
          bear: token('bear'),
          warn: token('warn'),
          info: token('info'),
          muted: token('muted'),

          // Semantic — tinted fills behind directional text (badges, pills, rows).
          'bull-deep': token('bull-deep'),
          'bear-deep': token('bear-deep'),
          'warn-deep': token('warn-deep'),
          'info-deep': token('info-deep'),
          'muted-deep': token('muted-deep'),
        },
      },

      // rem-based so the density control (root font-size) scales it.
      // 11px at normal density is the accessibility floor — nothing smaller.
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1.4' }],
      },

      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },

      boxShadow: {
        glow: '0 0 15px rgb(var(--c-accent) / 0.15)',
        'glow-lg': '0 0 30px rgb(var(--c-accent) / 0.2)',
        xs: '0 1px 2px rgb(0 0 0 / 0.25)',
      },

      spacing: {
        panel: 'var(--pad-panel)',
        row: 'var(--row-h)',
      },
    },
  },
  plugins: [],
}
