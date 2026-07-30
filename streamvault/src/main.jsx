import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ErrorBoundary from './ErrorBoundary.jsx'
import './legacy-polyfills.js'
import App from './App.jsx'
import AnalyticsConsent from './components/AnalyticsConsent.jsx'
import { initializeAnalytics } from './analytics.js'

initializeAnalytics()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <AnalyticsConsent />
    </ErrorBoundary>
  </StrictMode>,
)

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
