import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// Builds the extension into dist/ — load that folder via chrome://extensions → "Load unpacked".
// public/manifest.json is copied as-is.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // minified by default; set minify: false for readable output while debugging
    rollupOptions: {
      input: {
        options: 'options.html',
        background: 'src/background.js',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
