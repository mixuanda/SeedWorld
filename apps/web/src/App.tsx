import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TopNav } from './components/TopNav';
import { InboxPage } from './pages/InboxPage';
import { SettingsPage } from './pages/SettingsPage';
import { SeedWorldProvider } from './seedworld';

export default function App(): React.ReactElement {
  return (
    <SeedWorldProvider>
      <BrowserRouter>
        <div style={{ margin: '0 auto', maxWidth: 980, padding: 20, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
          <h1>SeedWorld Web</h1>
          <TopNav />
          <Routes>
            <Route path="/" element={<InboxPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </BrowserRouter>
    </SeedWorldProvider>
  );
}
