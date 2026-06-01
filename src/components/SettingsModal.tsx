import { X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { PresetsTab } from './settings-modal/PresetsTab';
import { GlobalSettingsTab } from './settings-modal/GlobalSettingsTab';

export function SettingsModal() {
  const { settingsOpen, toggleSettings } = useAppStore();

  if (!settingsOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Settings">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ember/40 backdrop-blur-sm" onClick={toggleSettings} />

      {/* Panel */}
      <div className="relative bg-surface border border-border w-full h-full sm:h-[85vh] sm:max-w-xl sm:mx-4 flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-border shrink-0 bg-void z-10">
          <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase glow-green">
            ⚙ SETTINGS
          </h2>
          <button onClick={toggleSettings} className="text-text-dim hover:text-danger transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-20">
          <PresetsTab />
          <GlobalSettingsTab />
        </div>
      </div>
    </div>
  );
}
