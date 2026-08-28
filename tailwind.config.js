/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './views/**/*.ejs',
    './Public/js/**/*.js',
  ],
  // Die App baut Klassen teils dynamisch aus firma.color_* / Status-Werten
  // zusammen (siehe partials/header.ejs, dashboard.ejs KPI-Farben). Der
  // Tailwind-Scanner findet nur Klassen, die als vollständiger String im
  // Quelltext stehen – dynamisch zusammengesetzte Klassen (`bg-${color}-400`)
  // würden sonst beim Build verschwinden. Deshalb hier absichern:
  safelist: [
    { pattern: /^bg-(amber|red|emerald|blue|orange|slate|green)-(50|100|400|500|600)$/ },
    { pattern: /^text-(amber|red|emerald|blue|orange|slate|green)-(400|500|600)$/ },
    { pattern: /^border-(amber|red|emerald|blue|orange|slate|green)-(400|500)$/ },
    { pattern: /^badge-(success|warning|danger|info|neutral)$/ },
  ],
  theme: {
    extend: {
      colors: {
        // Markenfarbe bleibt über CSS-Variablen in den Theme-Dateien
        // (Public/themes/*.css) gesteuert – hier nur als Tailwind-Utility
        // verfügbar machen, falls in Views bg-brand/text-brand genutzt wird.
        brand: 'var(--primary)',
        'brand-dark': 'var(--primary-dark)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
