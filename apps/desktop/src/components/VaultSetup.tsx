import React from 'react';

interface VaultSetupProps {
    onVaultSelected: (path: string) => void;
}

/**
 * First-run vault setup screen
 * Explains what the vault is and lets user choose a folder
 */
export function VaultSetup({ onVaultSelected }: VaultSetupProps): React.ReactElement {
    const [isSelecting, setIsSelecting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const handleSelectFolder = async () => {
        setIsSelecting(true);
        setError(null);

        try {
            const path = await window.api.vault.selectFolder();
            if (path) {
                onVaultSelected(path);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to select folder');
        } finally {
            setIsSelecting(false);
        }
    };

    return (
        <div className="vault-setup">
            <div className="vault-setup-content">
                <div className="vault-setup-icon">🗂️</div>
                <h1>Welcome to World-Seed</h1>
                <p className="vault-setup-description">
                    Choose a folder to store your notes. We recommend using a folder
                    inside <strong>OneDrive</strong> for automatic cloud sync.
                </p>

                <div className="vault-setup-features">
                    <div className="feature">
                        <span className="feature-icon">📁</span>
                        <span>Notes saved as plain Markdown files</span>
                    </div>
                    <div className="feature">
                        <span className="feature-icon">☁️</span>
                        <span>Syncs automatically via OneDrive</span>
                    </div>
                    <div className="feature">
                        <span className="feature-icon">🔒</span>
                        <span>Your data stays on your devices</span>
                    </div>
                </div>

                <button
                    className="vault-setup-button"
                    onClick={handleSelectFolder}
                    disabled={isSelecting}
                >
                    {isSelecting ? 'Selecting...' : 'Choose Vault Folder'}
                </button>

                {error && (
                    <p className="vault-setup-error">{error}</p>
                )}

                <p className="vault-setup-hint">
                    Tip: Create a new folder like <code>OneDrive/WorldSeed</code>
                </p>
            </div>
        </div>
    );
}

export default VaultSetup;
