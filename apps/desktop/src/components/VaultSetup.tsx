import React from 'react';
import { useTranslation } from 'react-i18next';

interface VaultSetupProps {
  onVaultSelected: (path: string) => void;
}

/**
 * First-run vault setup screen
 * Explains what the vault is and lets user choose/create a folder
 */
export function VaultSetup({ onVaultSelected }: VaultSetupProps): React.ReactElement {
  const { t } = useTranslation();
  const [isSelecting, setIsSelecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSelectFolder = async () => {
    setIsSelecting(true);
    setError(null);

    try {
      const selectedPath = await window.api.vault.selectFolder();
      if (selectedPath) {
        onVaultSelected(selectedPath);
      }
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : t('vaultSetup.selectError'));
    } finally {
      setIsSelecting(false);
    }
  };

  return (
    <div className="vault-setup">
      <div className="vault-setup-content">
        <div className="vault-setup-icon">🗂️</div>
        <h1>{t('vaultSetup.title')}</h1>
        <p className="vault-setup-description">
          {t('vaultSetup.description')}
        </p>

        <div className="vault-setup-features">
          <div className="feature">
            <span className="feature-icon">📁</span>
            <span>{t('vaultSetup.featurePlainFiles')}</span>
          </div>
          <div className="feature">
            <span className="feature-icon">☁️</span>
            <span>{t('vaultSetup.featureCloudSync')}</span>
          </div>
          <div className="feature">
            <span className="feature-icon">🔒</span>
            <span>{t('vaultSetup.featureDataControl')}</span>
          </div>
        </div>

        <div className="vault-setup-cta-row">
          <button
            className="vault-setup-button"
            onClick={handleSelectFolder}
            disabled={isSelecting}
          >
            {isSelecting ? t('vaultSetup.selecting') : t('vaultSetup.selectFolder')}
          </button>

          <button
            className="vault-setup-button secondary"
            onClick={handleSelectFolder}
            disabled={isSelecting}
          >
            {isSelecting ? t('vaultSetup.selecting') : t('vaultSetup.createVault')}
          </button>
        </div>

        {error && (
          <p className="vault-setup-error">{error}</p>
        )}

        <p className="vault-setup-hint">
          {t('vaultSetup.tip')}
        </p>
      </div>
    </div>
  );
}

export default VaultSetup;
