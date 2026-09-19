import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import './index.css'
import App from './App.tsx'

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!clerkPublishableKey) {
  // vite.config.ts aliases @clerk/react to a stub in this case; the app runs signed-out.
  console.warn('VITE_CLERK_PUBLISHABLE_KEY not set: authentication disabled')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={clerkPublishableKey ?? ''}>
      <App />
    </ClerkProvider>
  </StrictMode>,
)
