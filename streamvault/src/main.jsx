import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ErrorBoundary from './ErrorBoundary.jsx'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
