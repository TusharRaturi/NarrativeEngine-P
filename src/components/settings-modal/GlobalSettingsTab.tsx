import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { getEmbeddingStatus, runBackfill } from '../../services/backfillRunner';
import { api } from '../../services/apiClient';
import { toast } from '../Toast';
import { VaultSection } from './VaultSection';

export function GlobalSettingsTab() {
  const { settings, updateSettings } = useAppStore();

  const [reindexing, setReindexing] = useState(false);
  const [reindexStatus, setReindexStatus] = useState('');
  const [embedStatus, setEmbedStatus] = useState<import('../../services/backfillRunner').BackfillStatus | null>(null);
  const [rebuildingRules, setRebuildingRules] = useState(false);

  const handleReindex = async () => {
    const campaignId = useAppStore.getState().activeCampaignId;
    if (!campaignId) {
      toast.error('No active campaign');
      return;
    }
    setReindexing(true);
    setReindexStatus('Loading status...');
    try {
      const status = await getEmbeddingStatus(campaignId);
      setEmbedStatus(status);
      if (status.scenes.stale === 0 && status.lore.stale === 0) {
        toast.info('All embeddings are up to date');
        setReindexing(false);
        return;
      }
      setReindexStatus('Re-indexing...');
      const result = await runBackfill(campaignId, 'all', (msg) => setReindexStatus(msg));
      setEmbedStatus(result.status);
      toast.success(`Re-indexed ${result.reindexedScenes} scenes, ${result.reindexedLore} lore chunks`);
    } catch (err) {
      toast.error(`Re-index failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setReindexing(false);
      setReindexStatus('');
    }
  };

  const handleRebuildRules = async () => {
    const campaignId = useAppStore.getState().activeCampaignId;
    if (!campaignId) {
      toast.error('No active campaign');
      return;
    }
    setRebuildingRules(true);
    try {
      toast.info('Rebuilding rules embeddings...');
      const res = await api.rules.reindex(campaignId);
      if (res) {
        toast.success(`Successfully rebuilt ${res.totalChunks} rule chunks`);
      } else {
        toast.error('Rebuild failed');
      }
    } catch (err) {
      toast.error(`Rebuild failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRebuildingRules(false);
    }
  };

  return (
    <div className="mt-8 pt-6 border-t border-border space-y-6">
      <label className="text-text-dim text-xs uppercase tracking-widest font-bold block mb-4">Global Preferences</label>

      {/* Context Limit */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[11px] text-text-dim uppercase tracking-wider">
            Max Context Limit (Tokens)
          </label>
          <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-xs">
            {settings.contextLimit.toLocaleString()}
          </span>
        </div>

        <input
          type="number"
          min={0}
          step={1024}
          value={settings.contextLimit || 0}
          onChange={(e) => updateSettings({ contextLimit: Math.max(0, parseInt(e.target.value) || 0) })}
          className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary font-mono mb-2 focus:border-terminal focus:outline-none"
        />

        <div className="flex flex-wrap gap-1.5">
          {[4096, 8192, 16384, 32768, 65536, 131072, 262144, 1048576, 2097152].map(limit => (
            <button
              key={limit}
              onClick={() => updateSettings({ contextLimit: limit })}
              className={`px-2 py-1 text-[10px] uppercase font-mono border rounded transition-colors focus:outline-none ${settings.contextLimit === limit ? 'bg-terminal text-void border-terminal' : 'bg-surface border-border text-text-dim hover:text-text-primary hover:border-text-dim'}`}
            >
              {limit >= 1048576 ? `${limit / 1048576}M` : `${limit / 1024}K`}
            </button>
          ))}
        </div>
      </div>

      {/* Debug Mode */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">
          Debug Payload Viewer
        </label>
        <button
          onClick={() => updateSettings({ debugMode: !settings.debugMode })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.debugMode ? 'bg-terminal' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.debugMode ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>

      {/* Show Reasoning */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Show Reasoning (Thinking Blocks)
          </label>
          <p className="text-[9px] text-text-dim max-w-[200px] leading-tight">
            Show or hide the model's internal thinking process (&lt;think&gt; blocks)
          </p>
        </div>
        <button
          onClick={() => updateSettings({ showReasoning: !settings.showReasoning })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.showReasoning ? 'bg-terminal' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.showReasoning ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>

      {/* Deep Archive Search */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Deep Archive Search
          </label>
          <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
            Enables AI-driven full-archive scan. Adds a "Deep Search" button to the toolbar.
            Requires a utility AI endpoint. Adds ~1-2 min per turn when used.
          </p>
        </div>
        <button
          onClick={() => updateSettings({ deepContextSearch: !settings.deepContextSearch })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.deepContextSearch ? 'bg-amber-500' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.deepContextSearch ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>

      {/* Archive Agent Planner */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Archive Agent Planner
          </label>
          <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
            Enables an intelligent utility AI planner to rank archive scenes based on structured scene events before recall.
            Requires a utility AI endpoint and structured events populated.
          </p>
        </div>
        <button
          onClick={() => updateSettings({ enableArchivePlanner: !settings.enableArchivePlanner })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.enableArchivePlanner ? 'bg-terminal' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.enableArchivePlanner ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>

      {/* Re-index Embeddings */}
      <div className="bg-void p-3 border border-border rounded space-y-2">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Re-index Embeddings
          </label>
          <p className="text-[9px] text-text-dim max-w-[280px] leading-tight">
            Re-embeds stale or unversioned scene and lore vectors. Use after changing embedding models or if semantic search seems off.
          </p>
        </div>
        <button
          id="reindex-embeddings-btn"
          disabled={reindexing}
          onClick={handleReindex}
          className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          {reindexing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          {reindexing ? (reindexStatus || 'Re-indexing...') : 'Re-index Now'}
        </button>
        {embedStatus && !reindexing && (
          <div className="text-[9px] text-text-dim">
            Scenes: {embedStatus.scenes.current}/{embedStatus.scenes.total} current · Lore: {embedStatus.lore.current}/{embedStatus.lore.total} current
            {embedStatus.scenes.stale > 0 && ` · ${embedStatus.scenes.stale + embedStatus.lore.stale} stale`}
            {` (v${embedStatus.version})`}
          </div>
        )}
      </div>

      {/* Rules RAG Preferences */}
      <div className="bg-void p-3 border border-border rounded space-y-3">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Rules RAG Preferences
          </label>
          <p className="text-[9px] text-text-dim leading-tight">
            Configure rules retrieval-augmented generation (RAG) settings, budget limits, and background extraction behavior.
          </p>
        </div>

        {/* Rules Context Budget Slider */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Rules Context Budget
            </label>
            <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
              {Math.round((settings.rulesBudgetPct ?? 0.10) * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.05}
            value={settings.rulesBudgetPct ?? 0.10}
            onChange={(e) => updateSettings({ rulesBudgetPct: parseFloat(e.target.value) })}
            className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-terminal"
          />
          <div className="flex justify-between text-[8px] text-text-dim mt-0.5">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
          </div>
        </div>

        {/* Auto-Generate Keywords Toggle */}
        <div className="flex items-center justify-between py-1.5 border-t border-border/30">
          <div>
            <label className="block text-[10px] text-text-primary uppercase tracking-wider font-bold mb-0.5">
              Auto-Generate Keywords
            </label>
            <p className="text-[9px] text-text-dim leading-tight">
              Automatically extract lookup keywords from rules using Utility AI.
            </p>
          </div>
          <button
            onClick={() => updateSettings({ autoGenerateRuleKeywords: !settings.autoGenerateRuleKeywords })}
            className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.autoGenerateRuleKeywords ? 'bg-terminal' : 'bg-border'}`}
          >
            <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.autoGenerateRuleKeywords ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>

        {/* Utility AI Timeout Field */}
        <div className="pt-2 border-t border-border/30">
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Utility AI Timeout (Seconds)
            </label>
          </div>
          <input
            type="number"
            min={5}
            max={300}
            step={5}
            value={settings.utilityTimeoutSeconds ?? 45}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (!isNaN(v) && v > 0) updateSettings({ utilityTimeoutSeconds: v });
            }}
            className="w-full h-7 bg-surface border border-border rounded px-2 text-xs text-text font-mono focus:outline-none focus:border-terminal"
          />
        </div>

        {/* Rebuild Rules Embeddings Button */}
        <div className="pt-2 border-t border-border/30 flex items-center justify-between">
          <div>
            <label className="block text-[10px] text-text-primary uppercase tracking-wider font-bold mb-0.5">
              Rebuild Rules Embeddings
            </label>
            <p className="text-[9px] text-text-dim max-w-[200px] leading-tight">
              Manually parse and re-embed rules markdown.
            </p>
          </div>
          <button
            disabled={rebuildingRules}
            onClick={handleRebuildRules}
            className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {rebuildingRules ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
            {rebuildingRules ? 'Rebuilding...' : 'Rebuild Now'}
          </button>
        </div>
      </div>

      {/* Divergence Register */}
      <div className="bg-void p-3 border border-border rounded space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
              Auto-Extract Divergences
            </label>
            <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
              Automatically extract campaign facts (canon changes, NPC states, obligations) from each turn.
              Importance gate: 7+ (use ⚡ for lower).
            </p>
          </div>
          <button
            onClick={() => updateSettings({ autoExtractDivergences: !settings.autoExtractDivergences })}
            className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.autoExtractDivergences ? 'bg-amber-500' : 'bg-border'}`}
          >
            <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.autoExtractDivergences ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Divergence Token Budget
            </label>
          </div>
          <input
            type="number"
            min={500}
            step={250}
            value={settings.divergenceTokenBudget ?? 2000}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (!isNaN(v) && v > 0) updateSettings({ divergenceTokenBudget: v });
            }}
            className="w-full h-7 bg-surface border border-border rounded px-2 text-xs text-text font-mono focus:outline-none focus:border-amber-500"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Scan Budget (per batch)
            </label>
            <span className="text-amber-500 font-bold font-mono bg-amber-500/10 px-2 py-0.5 rounded text-[10px]">
              {(() => {
                const v = settings.divergenceScanBudget ?? 0;
                if (v === 0) {
                  const ctx = settings.contextLimit ?? 4096;
                  return `Auto (${Math.round(ctx * 0.75)})`;
                }
                return v;
              })()}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={settings.contextLimit ?? 4096}
            step={500}
            value={settings.divergenceScanBudget ?? 0}
            onChange={(e) => updateSettings({ divergenceScanBudget: parseInt(e.target.value) })}
            className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-amber-500"
          />
          <div className="flex justify-between text-[8px] text-text-dim mt-0.5">
            <span>Auto (0)</span>
            <span>{settings.contextLimit ?? 4096}</span>
          </div>
          <p className="text-[8px] text-text-dim mt-1 leading-tight">
            Max tokens per batch for scanning chapters. 0 = auto (75% of context limit).
          </p>
        </div>
      </div>

      {/* Auto-Trim (Auto-Condense) */}
      <div className="bg-void p-3 border border-border rounded space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
              Auto-Trim
            </label>
            <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
              Automatically condense history when it exceeds a token budget. Prevents context overflow without manual intervention.
            </p>
          </div>
          <button
            onClick={() => updateSettings({ autoCondenseEnabled: !(settings.autoCondenseEnabled ?? true) })}
            className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${(settings.autoCondenseEnabled ?? true) ? 'bg-terminal' : 'bg-border'}`}
          >
            <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${(settings.autoCondenseEnabled ?? true) ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Aggressiveness
            </label>
            <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
              {(() => {
                const a = settings.condenseAggressiveness ?? 'smart';
                if (a === 'tight') return 'Tight (50%)';
                if (a === 'deep') return 'Deep (90%)';
                return 'Smart (75%)';
              })()}
            </span>
          </div>
          <div className="flex border border-border overflow-hidden rounded">
            {(['tight', 'smart', 'deep'] as const).map(level => (
              <button
                key={level}
                onClick={() => updateSettings({ condenseAggressiveness: level })}
                className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(settings.condenseAggressiveness ?? 'smart') === level
                  ? 'bg-terminal text-void font-bold'
                  : 'bg-void text-text-dim hover:text-text-primary'
                }`}
              >
                {level === 'tight' ? 'Tight' : level === 'smart' ? 'Smart' : 'Deep'}
              </button>
            ))}
          </div>
          <p className="text-[8px] text-text-dim mt-1.5 leading-tight">
            {(() => {
              const a = settings.condenseAggressiveness ?? 'smart';
              if (a === 'tight') return 'Condenses early at 50% budget — smaller context, more frequent compression.';
              if (a === 'deep') return 'Condenses only at 90% budget — maximum context before compression.';
              return 'Balanced — condenses at 75% budget threshold.';
            })()}
          </p>
        </div>
      </div>

      {/* Auto-Archive Stale NPCs */}
      <div className="bg-void p-3 border border-border rounded space-y-2">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Auto-Archive Stale NPCs
          </label>
          <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
            Archive NPCs not mentioned for N turns. 0 = never auto-archive.
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Turns before archive
            </label>
            <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
              {(() => {
                const v = settings.autoArchiveStaleNPCsTurns ?? 0;
                return v === 0 ? 'Off' : `${v} turns`;
              })()}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="50"
            step="5"
            value={settings.autoArchiveStaleNPCsTurns ?? 0}
            onChange={(e) => updateSettings({ autoArchiveStaleNPCsTurns: parseInt(e.target.value, 10) })}
            className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-terminal"
          />
          <div className="flex justify-between text-[8px] text-text-dim mt-0.5">
            <span>Off (0)</span>
            <span>25</span>
            <span>50</span>
          </div>
        </div>
      </div>

      {/* Theme */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">
          UI Theme
        </label>
        <div className="flex border border-border overflow-hidden rounded">
          <button
            onClick={() => updateSettings({ theme: 'light' })}
            className={`px-4 py-1.5 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(settings.theme ?? 'light') === 'light'
              ? 'bg-terminal text-surface font-bold'
              : 'bg-void text-text-dim hover:text-text-primary'
              }`}
          >
            ☀ Light
          </button>
          <button
            onClick={() => updateSettings({ theme: 'dark' })}
            className={`px-4 py-1.5 text-[10px] uppercase tracking-wider transition-colors border-l border-border focus:outline-none ${settings.theme === 'dark'
              ? 'bg-terminal text-surface font-bold'
              : 'bg-void text-text-dim hover:text-text-primary'
              }`}
          >
            ☽ Dark
          </button>
        </div>
      </div>

      {/* Vault Export/Import */}
      <VaultSection />
    </div>
  );
}
