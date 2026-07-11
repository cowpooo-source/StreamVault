import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      } catch (e) { console.warn("Service worker version update failed:", e.message); }
    }
  };
}

function directContentConfigPlugin() {
  return {
    name: 'direct-content-config',
    configResolved(config) {
      if (!config.isProduction) return;
      const value = config.env.VITE_SECURE_APP_BASE_URL;
      if (!value) throw new Error('VITE_SECURE_APP_BASE_URL is required for production builds');
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error('VITE_SECURE_APP_BASE_URL must be a valid URL');
      }
      if (url.protocol !== 'https:') {
        throw new Error('VITE_SECURE_APP_BASE_URL must use HTTPS in production');
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    directContentConfigPlugin(),
    swVersionPlugin(),
    legacy({
      targets: ['chrome >= 68', 'safari >= 13', 'ios >= 13', 'samsung >= 10'],
      additionalLegacyPolyfills: ['regenerator-runtime/runtime']
    })
  ],

  server: {
    proxy: {
      '/stalker': { target: 'http://localhost:3201', changeOrigin: true },
      '/stream': { target: 'http://localhost:3201', changeOrigin: true },
      '/proxy': { target: 'http://localhost:3201', changeOrigin: true },
      '/img': { target: 'http://localhost:3201', changeOrigin: true },
      '/health': { target: 'http://localhost:3201', changeOrigin: true },
      '/api': { target: 'http://localhost:3201', changeOrigin: true },
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
