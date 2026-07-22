import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { copyFileSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const publicPages = new Set(['/features', '/security', '/self-host', '/faq', '/privacy', '/terms'])

function routeEntryPlugin() {
  const rewriteEntry = (req, _res, next) => {
    const requestUrl = new URL(req.url || '/', 'http://vite.local')
    const { pathname, search } = requestUrl

    if (pathname === '/app' || pathname.startsWith('/app/') || pathname === '/content') {
      req.url = `/app.html${search}`
    } else if (publicPages.has(pathname)) {
      req.url = `${pathname}.html${search}`
    }
    next()
  }

  return {
    name: 'route-entry-pages',
    configureServer(server) {
      server.middlewares.use(rewriteEntry)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewriteEntry)
    },
  }
}

function staticPageCopyPlugin() {
  const pages = ['landing.html', 'features.html', 'security.html', 'self-host.html', 'faq.html', 'privacy.html', 'terms.html', '404.html']
  return {
    name: 'static-page-copy',
    closeBundle() {
      for (const page of pages) copyFileSync(resolve(__dirname, page), resolve(__dirname, 'dist', page))
    },
  }
}

// Inject a unique build version so an active service worker replaces stale bundles.
function swVersionPlugin() {
  return {
    name: 'sw-version',
    writeBundle() {
      const swPath = resolve('dist/sw.js')
      try {
        let sw = readFileSync(swPath, 'utf8')
        const version = `sv-${Date.now().toString(36)}`
        sw = sw.replace(/const CACHE = "[^"]+";/, `const CACHE = "${version}";`)
        writeFileSync(swPath, sw)
      } catch (error) {
        console.warn('Service worker version update failed:', error.message)
      }
    },
  }
}

function directContentConfigPlugin() {
  return {
    name: 'direct-content-config',
    configResolved(config) {
      if (!config.isProduction) return
      const value = config.env.VITE_SECURE_APP_BASE_URL
      if (!value) throw new Error('VITE_SECURE_APP_BASE_URL is required for production builds')

      let url
      try {
        url = new URL(value)
      } catch {
        throw new Error('VITE_SECURE_APP_BASE_URL must be a valid URL')
      }
      if (url.protocol !== 'https:') {
        throw new Error('VITE_SECURE_APP_BASE_URL must use HTTPS in production')
      }
    },
  }
}

export default defineConfig({
  appType: 'mpa',
  plugins: [
    routeEntryPlugin(),
    react(),
    directContentConfigPlugin(),
    swVersionPlugin(),
    staticPageCopyPlugin(),
    legacy({
      targets: ['chrome >= 68', 'safari >= 13', 'ios >= 13', 'samsung >= 10'],
      additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
    }),
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
    target: 'es2020',
    rollupOptions: {
      input: {
        marketing: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react'
          }
        },
      },
    },
  },
})
