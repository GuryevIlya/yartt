import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Imported, not read: Vite restarts the dev server when it changes, so a new version shows at once.
import pkg from '../package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  // Relative to <base>, which the server sets: one build serves any path (PUBLIC_URL).
  base: './',
  // The release in the footer of My day (vite-env.d.ts).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
