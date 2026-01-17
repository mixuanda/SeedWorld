/**
 * World-Seed Renderer Entry
 * Mounts the React application
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Mount React app to root container
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

const root = createRoot(container);
root.render(React.createElement(App));

console.log('🌱 World-Seed renderer loaded');
