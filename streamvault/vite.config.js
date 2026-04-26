import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Inject build version into SW on each build so browser detects changes
function swVersionPlugin() {
  return {
    name: 'sw-version',
    writeBundle() {
      const swPath = resolve('dist/sw.js');
      try {
        let sw = readFileSync(swPath, 'utf8');
        const version = `sv-${Date.now().toString(36)}`;
        sw = sw.replace(/const CACHE = "[^"]+";/, `const CACHE = "${version}";`);
        writeFileSync(swPath, sw);
      } catch {}
    }
  };
}

export default defineConfig({
  plugins: [react(), swVersionPlugin()],

  server: {
    proxy: {
      '/stalker': { target: 'http://localhost:3001', changeOrigin: true },
      '/stream': { target: 'http://localhost:3001', changeOrigin: true },
      '/proxy': { target: 'http://localhost:3001', changeOrigin: true },
      '/img': { target: 'http://localhost:3001', changeOrigin: true },
      '/health': { target: 'http://localhost:3001', changeOrigin: true },
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },

  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, 'landing.html')
      },
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react';
          }
        },
      },
    },
  },
})
