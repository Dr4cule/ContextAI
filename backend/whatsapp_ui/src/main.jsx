import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { JobsProvider } from './state/jobsStore'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <JobsProvider>
        <App />
      </JobsProvider>
    </BrowserRouter>
  </React.StrictMode>
)
