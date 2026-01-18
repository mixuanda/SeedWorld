import React, { useState, useEffect } from 'react';
import type { ProviderConfig, LocalProviderConfig, TestConnectionResult } from '../global';

interface SettingsProps {
    onClose: () => void;
}

/**
 * Settings panel for AI provider configuration
 * Focuses on local-first AI (OpenAI-compatible endpoints)
 */
export function Settings({ onClose }: SettingsProps): React.ReactElement {
    // Form state
    const [mode, setMode] = useState<'local' | 'online'>('local');
    const [baseUrl, setBaseUrl] = useState('http://localhost:1234/v1');
    const [model, setModel] = useState('');

    // UI state
    const [isTesting, setIsTesting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Load existing config on mount
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const config = await window.api.ai.getConfig();
                if (config) {
                    setMode(config.mode);
                    if (config.mode === 'local') {
                        setBaseUrl(config.baseUrl);
                        setModel(config.model);
                    }
                }
            } catch (err) {
                console.error('[Settings] Failed to load config:', err);
            }
        };
        loadConfig();
    }, []);

    const buildConfig = (): ProviderConfig => {
        if (mode === 'local') {
            return {
                mode: 'local',
                baseUrl: baseUrl.trim(),
                model: model.trim(),
            } satisfies LocalProviderConfig;
        }
        // Online mode would need API key input (not implemented in this local-first version)
        throw new Error('Online mode not yet implemented');
    };

    const handleTestConnection = async () => {
        setIsTesting(true);
        setTestResult(null);
        setError(null);

        try {
            const config = buildConfig();
            const result = await window.api.ai.testConnection(config);
            setTestResult(result);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Test failed');
        } finally {
            setIsTesting(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        setError(null);

        try {
            const config = buildConfig();
            await window.api.ai.setConfig(config);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Save failed');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
                <header className="settings-header">
                    <h2>⚙️ AI Settings</h2>
                    <button className="settings-close" onClick={onClose}>×</button>
                </header>

                <div className="settings-content">
                    {/* Mode Selection */}
                    <div className="settings-section">
                        <label className="settings-label">Mode</label>
                        <div className="settings-radio-group">
                            <label className={`settings-radio ${mode === 'local' ? 'active' : ''}`}>
                                <input
                                    type="radio"
                                    name="mode"
                                    value="local"
                                    checked={mode === 'local'}
                                    onChange={() => setMode('local')}
                                />
                                <span className="radio-icon">🖥️</span>
                                <span className="radio-text">
                                    <strong>Local</strong>
                                    <small>LM Studio, Ollama, etc.</small>
                                </span>
                            </label>
                            <label className={`settings-radio ${mode === 'online' ? 'active' : ''} disabled`}>
                                <input
                                    type="radio"
                                    name="mode"
                                    value="online"
                                    disabled
                                />
                                <span className="radio-icon">☁️</span>
                                <span className="radio-text">
                                    <strong>Online</strong>
                                    <small>Coming soon</small>
                                </span>
                            </label>
                        </div>
                    </div>

                    {/* Local Mode Settings */}
                    {mode === 'local' && (
                        <>
                            <div className="settings-section">
                                <label className="settings-label" htmlFor="baseUrl">
                                    Base URL
                                    <span className="settings-hint">OpenAI-compatible endpoint</span>
                                </label>
                                <input
                                    id="baseUrl"
                                    type="text"
                                    className="settings-input"
                                    value={baseUrl}
                                    onChange={(e) => setBaseUrl(e.target.value)}
                                    placeholder="http://localhost:1234/v1"
                                />
                            </div>

                            <div className="settings-section">
                                <label className="settings-label" htmlFor="model">
                                    Model
                                    <span className="settings-hint">e.g., qwen2.5-coder, llama3.2</span>
                                </label>
                                <input
                                    id="model"
                                    type="text"
                                    className="settings-input"
                                    value={model}
                                    onChange={(e) => setModel(e.target.value)}
                                    placeholder="Enter model name"
                                />
                            </div>
                        </>
                    )}

                    {/* Test Connection */}
                    <div className="settings-section">
                        <button
                            className="settings-test-button"
                            onClick={handleTestConnection}
                            disabled={isTesting || !model.trim()}
                        >
                            {isTesting ? 'Testing...' : '🔌 Test Connection'}
                        </button>

                        {testResult && (
                            <div className={`settings-test-result ${testResult.success ? 'success' : 'error'}`}>
                                <div className="test-status">
                                    {testResult.success ? '✅' : '❌'} {testResult.message}
                                </div>
                                <div className="test-meta">
                                    Latency: {testResult.latencyMs}ms
                                    {testResult.model && ` · Model: ${testResult.model}`}
                                </div>
                            </div>
                        )}

                        {error && (
                            <div className="settings-error">{error}</div>
                        )}
                    </div>
                </div>

                <footer className="settings-footer">
                    <button className="settings-cancel" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className="settings-save"
                        onClick={handleSave}
                        disabled={isSaving || !model.trim()}
                    >
                        {isSaving ? 'Saving...' : 'Save'}
                    </button>
                </footer>
            </div>
        </div>
    );
}

export default Settings;
