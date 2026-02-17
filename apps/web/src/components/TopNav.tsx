import React from 'react';
import { NavLink } from 'react-router-dom';

function linkStyle(isActive: boolean): React.CSSProperties {
  return {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #d2d7df',
    textDecoration: 'none',
    color: isActive ? '#0b3f7f' : '#1f2937',
    background: isActive ? '#dbeafe' : '#ffffff',
    fontWeight: 600,
  };
}

export function TopNav(): React.ReactElement {
  return (
    <nav style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <NavLink to="/" style={({ isActive }) => linkStyle(isActive)} end>
        Inbox
      </NavLink>
      <NavLink to="/settings" style={({ isActive }) => linkStyle(isActive)}>
        Settings
      </NavLink>
    </nav>
  );
}
