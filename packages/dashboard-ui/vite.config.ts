import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  build: {
    // The sidecar serves this directory; the CLI package ships it.
    outDir: '../cli/web',
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev` against a live network: the sidecar carries the data.
    proxy: {
      '/api': 'http://127.0.0.1:8090',
    },
  },
});
