import React, { useState, useEffect } from 'react';
import type {
    ProviderConfig,
    LocalProviderConfig,
    TestConnectionResult,
    WhisperProgress,
    WhisperStatus,
} from '../global';

interface SettingsProps {
    onClose: () => void;
    embedded?: boolean;
}

/**
 * Settings panel for AI provider configuration
 * Focuses on local-first AI (OpenAI-compatible endpoints)
 */
export function Settings({ onClose, embedded = false }: SettingsProps): React.ReactElement {
    // Form state
    const [mode, setMode] = useState<'local' | 'online'>('local');
    const [baseUrl, setBaseUrl] = useState('http://localhost:1234/v1');
    const [model, setModel] = useState('');

    // UI state
    const [isTesting, setIsTesting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null);
    const [whisperLoading, setWhisperLoading] = useState(true);
    const [whisperBusy, setWhisperBusy] = useState<'install' | 'uninstall' | null>(null);
    const [whisperError, setWhisperError] = useState<string | null>(null);
    const [whisperProgress, setWhisperProgress] = useState<WhisperProgress | null>(null);
    const [whisperModelChoice, setWhisperModelChoice] = useState('base');

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

    useEffect(() => {
        const loadWhisperStatus = async () => {
            setWhisperLoading(true);
            setWhisperError(null);
            try {
                const status = await window.api.whisper.getStatus();
                setWhisperStatus(status);
                if (status.availableModels?.length) {
                    const defaultModel = status.model || (status.availableModels.includes('base') ? 'base' : status.availableModels[0]);
                    setWhisperModelChoice(defaultModel);
                } else if (status.model) {
                    setWhisperModelChoice(status.model);
                }
            } catch (err) {
                setWhisperError(err instanceof Error ? err.message : 'Failed to load Whisper status');
            } finally {
                setWhisperLoading(false);
            }
        };
        loadWhisperStatus();
    }, []);

    useEffect(() => {
        return window.api.whisper.onProgress((progress) => {
            setWhisperProgress(progress);
        });
    }, []);

    const buildConfig = (): ProviderConfig => {
        if (mode === 'local') {
            return {
                mode: 'local',
                baseUrl: baseUrl.trim(),
                model: model.trim(),
            } as LocalProviderConfig;
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

    const handleWhisperInstall = async () => {
        setWhisperBusy('install');
        setWhisperError(null);
        setWhisperProgress(null);

        try {
            const status = await window.api.whisper.install(whisperModelChoice);
            setWhisperStatus(status);
            if (status.model) {
                setWhisperModelChoice(status.model);
            }
        } catch (err) {
            setWhisperError(err instanceof Error ? err.message : 'Install failed');
        } finally {
            setWhisperBusy(null);
            setWhisperProgress(null);
        }
    };

    const handleWhisperUninstall = async () => {
        setWhisperBusy('uninstall');
        setWhisperError(null);
        setWhisperProgress(null);

        try {
            const status = await window.api.whisper.uninstall();
            setWhisperStatus(status);
            if (status.availableModels?.length) {
                const defaultModel = status.model || (status.availableModels.includes('base') ? 'base' : status.availableModels[0]);
                setWhisperModelChoice(defaultModel);
            }
        } catch (err) {
            setWhisperError(err instanceof Error ? err.message : 'Uninstall failed');
        } finally {
            setWhisperBusy(null);
            setWhisperProgress(null);
        }
    };

    const formatBytes = (bytes: number | null): string => {
        if (!bytes || bytes <= 0) return '-';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }

        const precision = unitIndex === 0 ? 0 : value >= 10 ? 0 : 1;
        return `${value.toFixed(precision)} ${units[unitIndex]}`;
    };

    const whisperState = whisperStatus?.state || 'not_installed';
    const whisperIsUnsupported = whisperState === 'unsupported';
    const whisperIsInstalled = whisperState === 'installed';
    const whisperIsBroken = whisperState === 'broken';
    const whisperIsNotInstalled = whisperState === 'not_installed';
    const whisperVersion = whisperStatus?.version || '-';
    const whisperModel = whisperStatus?.model || '-';
    const whisperSize = formatBytes(whisperStatus?.sizeBytes ?? null);
    const whisperMessage = whisperStatus?.message || null;
    const whisperAvailableModels = whisperStatus?.availableModels?.length
        ? whisperStatus.availableModels
        : ['tiny', 'base', 'small'];
    const whisperProgressLabel = whisperProgress
        ? `${whisperProgress.message}${whisperProgress.percent !== null ? ` (${whisperProgress.percent}%)` : ''}`
        : null;
    const whisperInProgress = whisperBusy === 'install' || whisperProgress !== null;
    const whisperInstallLabel = whisperIsBroken ? 'Reinstall' : 'Download & Install';
    const whisperCanInstall = whisperIsNotInstalled || whisperIsBroken;
    const whisperCanUninstall = whisperIsInstalled || whisperIsBroken;
    const whisperModelDisabled = whisperLoading || whisperInProgress || whisperIsUnsupported || (whisperIsInstalled && !whisperIsBroken);
    const formatPlatformKey = (platformKey?: string | null): string => {
        if (!platformKey) return '-';
        const parts = platformKey.split('-');
        const platform = parts.shift();
        const arch = parts.join('-');
        if (!platform) return platformKey;
        return arch ? `${platform} / ${arch}` : platform;
    };

    const panel = (
        <div className={`settings-panel ${embedded ? 'embedded' : ''}`} onClick={(e) => e.stopPropagation()}>
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

                    {/* Whisper Add-on */}
                    <div className="settings-section">
                        <label className="settings-label">Whisper Add-on</label>
                        <span className="settings-hint">Optional local speech-to-text engine</span>

                        <div className="whisper-status">
                            <div className="whisper-status-label">Status</div>
                            <div className="whisper-status-value">
                                {whisperLoading
                                    ? 'Loading...'
                                    : whisperIsUnsupported
                                        ? 'Unsupported'
                                        : whisperIsBroken
                                            ? 'Broken'
                                            : whisperIsInstalled
                                                ? 'Installed'
                                                : 'Not installed'}
                            </div>

                            <div className="whisper-status-label">Detected</div>
                            <div className="whisper-status-value">
                                {whisperLoading ? 'Loading...' : formatPlatformKey(whisperStatus?.platformKey)}
                            </div>

                            <div className="whisper-status-label">Version</div>
                            <div className="whisper-status-value">
                                {whisperLoading ? 'Loading...' : whisperVersion}
                            </div>

                            <div className="whisper-status-label">Model</div>
                            <div className="whisper-status-value">
                                {whisperLoading ? 'Loading...' : whisperModel}
                            </div>

                            <div className="whisper-status-label">Size</div>
                            <div className="whisper-status-value">
                                {whisperLoading ? 'Loading...' : whisperSize}
                            </div>
                        </div>

                        <div className="whisper-model-select">
                            <label className="settings-label" htmlFor="whisper-model">
                                Model to install
                            </label>
                            <select
                                id="whisper-model"
                                className="settings-input whisper-select"
                                value={whisperModelChoice}
                                onChange={(event) => setWhisperModelChoice(event.target.value)}
                                disabled={whisperModelDisabled}
                            >
                                {whisperAvailableModels.map((modelName) => (
                                    <option key={modelName} value={modelName}>
                                        {modelName}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {whisperMessage && (
                            <div className="whisper-message">{whisperMessage}</div>
                        )}

                        {whisperProgressLabel && (
                            <div className="whisper-progress">
                                <div className="whisper-progress-text">{whisperProgressLabel}</div>
                                {whisperProgress?.percent !== null && (
                                    <div className="whisper-progress-bar">
                                        <div
                                            className="whisper-progress-fill"
                                            style={{ width: `${whisperProgress?.percent ?? 0}%` }}
                                        />
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="whisper-actions">
                            <button
                                className="settings-save"
                                onClick={handleWhisperInstall}
                                disabled={whisperLoading || whisperInProgress || whisperIsUnsupported || !whisperCanInstall}
                            >
                                {whisperInProgress ? 'Installing...' : whisperInstallLabel}
                            </button>
                            <button
                                className="settings-cancel"
                                onClick={handleWhisperUninstall}
                                disabled={whisperLoading || whisperBusy !== null || !whisperCanUninstall}
                            >
                                {whisperBusy === 'uninstall' ? 'Uninstalling...' : 'Uninstall'}
                            </button>
                        </div>

                        {whisperError && (
                            <div className="settings-error">{whisperError}</div>
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
    );

    if (embedded) {
        return <div className="settings-embedded">{panel}</div>;
    }

    return (
        <div className="settings-overlay" onClick={onClose}>
            {panel}
        </div>
    );
}

export default Settings;
