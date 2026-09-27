import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client is a plain SPA served by the API in production, so there is no
 * second origin to configure and no CORS to get wrong. In development Vite
 * proxies `/api` to the API process, which keeps cookies same-origin and means
 * the dev setup exercises the real CSRF and cookie path rather than a
 * special-case one.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Source maps in a self-hosted deployment help an operator debug a broken
    // bundle without a separate artifact pipeline.
    sourcemap: true,
    target: 'es2022',
  },
});
