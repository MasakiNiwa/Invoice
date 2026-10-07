import { HashRouter, Route, Routes } from 'react-router'
import { BottomBar, TopBar } from './NavBar'
import { useTheme } from './useTheme'
import ScanPage from '../pages/ScanPage'
import SettingsPage from '../pages/SettingsPage'
import HelpPage from '../pages/HelpPage'
import AboutPage from '../pages/AboutPage'
import HistoryPage from '../pages/HistoryPage'

export default function App() {
  useTheme()
  return (
    <HashRouter>
      <TopBar />
      <main className="mx-auto max-w-6xl px-3 pb-24 pt-4 sm:px-4 md:pb-10">
        <Routes>
          <Route path="/" element={<ScanPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<ScanPage />} />
        </Routes>
      </main>
      <BottomBar />
    </HashRouter>
  )
}
