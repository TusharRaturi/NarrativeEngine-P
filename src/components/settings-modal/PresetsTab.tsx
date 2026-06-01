import { useState } from 'react';
import { Loader2, CheckCircle, XCircle, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { testConnection } from '../../services/chatEngine';
import type { AIPreset, EndpointConfig, ApiFormat, SamplingConfig, ThinkingEffort } from '../../types';
import { detectFormatFromEndpoint } from '../../utils/llmApiHelper';
import { toast } from '../Toast';
import { uid } from '../../utils/uid';
import { SamplingPanel } from '../SamplingPanel';

export function PresetsTab() {
  const { settings, addPreset, updatePreset, removePreset } = useAppStore();
  const [activeTab, setActiveTab] = useState(settings.presets[0]?.id || '');
  const [testingSection, setTestingSection] = useState<'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI' | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string } | null>>({});

  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    storyAI: true,
    imageAI: false,
    summarizerAI: false,
    utilityAI: false,
    auxiliaryAI: false,
  });

  const activePreset = settings.presets.find((p) => p.id === activeTab) || settings.presets[0];

  const handleTest = async (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI') => {
    if (!activePreset) return;
    const config = activePreset[section];
    if (!config || !config.endpoint) return;

    setTestingSection(section);
    setTestResults(prev => ({ ...prev, [section]: null }));
    const result = await testConnection(config);
    setTestResults(prev => ({ ...prev, [section]: result }));
    setTestingSection(null);
    if (result.ok) {
      toast.success(`${section} connection successful`);
    } else {
      toast.error(`${section} connection failed: ${result.detail}`);
    }
  };

  const handleAddPreset = () => {
    const newPreset: AIPreset = {
      id: uid(),
      name: `Preset ${settings.presets.length + 1}`,
      storyAI: { endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3', apiFormat: 'openai' },
      imageAI: { endpoint: '', apiKey: '', modelName: '' },
      summarizerAI: { endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3', apiFormat: 'openai' },
      utilityAI: { endpoint: '', apiKey: '', modelName: '' },
      auxiliaryAI: { endpoint: '', apiKey: '', modelName: '' }
    };
    addPreset(newPreset);
    setActiveTab(newPreset.id);
    setTestResults({});
  };

  const handleRemovePreset = (id: string) => {
    if (settings.presets.length <= 1) return;
    removePreset(id);
    const updatedPresets = useAppStore.getState().settings.presets;
    setActiveTab(updatedPresets[0]?.id || '');
    setTestResults({});
  };

  const handleUpdatePresetName = (name: string) => {
    if (!activePreset) return;
    updatePreset(activePreset.id, { name });
  };

  const handleUpdateEndpoint = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI', field: keyof EndpointConfig, value: string) => {
    if (!activePreset) return;
    const updatedConfig = { ...activePreset[section], [field]: value };
    updatePreset(activePreset.id, { [section]: updatedConfig });
  };

  const handleApiFormatChange = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI', newFormat: ApiFormat) => {
    if (!activePreset) return;
    const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' };
    let endpoint = (config.endpoint || '').replace(/\/+$/, '');
    if (newFormat === 'ollama') {
      endpoint = endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    } else if (newFormat === 'claude') {
      endpoint = 'https://api.anthropic.com/v1';
    } else if (newFormat === 'gemini') {
      endpoint = 'https://generativelanguage.googleapis.com/v1beta';
    } else {
      // OpenAI format — if endpoint looks like a bare Ollama host, add /v1
      if (/localhost:11434|127\.0\.0\.1:11434/.test(endpoint) && !endpoint.endsWith('/v1')) {
        endpoint = endpoint + '/v1';
      }
    }
    updatePreset(activePreset.id, { [section]: { ...config, apiFormat: newFormat, endpoint } });
  };

  const handleEndpointBlur = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI', endpoint: string) => {
    if (!activePreset || !endpoint) return;
    const detected = detectFormatFromEndpoint(endpoint);
    if (!detected) return;
    const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' };
    const currentFormat = (config as EndpointConfig).apiFormat || 'openai';
    if (currentFormat === detected) return;
    let normalizedEndpoint = endpoint.replace(/\/+$/, '');
    if (detected === 'ollama') {
      normalizedEndpoint = normalizedEndpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    }
    updatePreset(activePreset.id, { [section]: { ...config, apiFormat: detected, endpoint: normalizedEndpoint } });
  };

  const toggleSection = (section: string) => {
    setExpanded(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleUpdateSampling = (sampling: SamplingConfig) => {
    if (!activePreset) return;
    updatePreset(activePreset.id, { sampling });
  };

  const renderEndpointConfig = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI', title: string) => {
    const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '', apiFormat: 'openai' as ApiFormat };
    const isExpanded = expanded[section];
    const isTesting = testingSection === section;
    const result = testResults[section];
    const currentFormat = (config.apiFormat || 'openai') as ApiFormat;
    const isImageSection = section === 'imageAI';
    const availableFormats: ApiFormat[] = isImageSection
      ? ['openai', 'ollama']
      : ['openai', 'ollama', 'claude', 'gemini'];

    const formatLabel = (fmt: ApiFormat): string => {
      switch (fmt) {
        case 'openai': return 'OpenAI';
        case 'ollama': return 'Ollama';
        case 'claude': return 'Claude';
        case 'gemini': return 'Gemini';
      }
    };

    const endpointPlaceholder = (): string => {
      switch (currentFormat) {
        case 'ollama': return 'http://localhost:11434';
        case 'claude': return 'https://api.anthropic.com/v1';
        case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta';
        default: return 'http://localhost:11434/v1';
      }
    };

    return (
      <div className="border border-border rounded mb-3 bg-void-lighter overflow-hidden">
        <button
          onClick={() => toggleSection(section)}
          className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors"
        >
          <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
            {isExpanded ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
            {title}
          </div>
        </button>

        {isExpanded && (
          <div className="p-4 space-y-4 border-t border-border bg-void">
            <div>
              <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Endpoint</label>
              <input
                type="text"
                value={config.endpoint}
                onChange={(e) => handleUpdateEndpoint(section, 'endpoint', e.target.value)}
                onBlur={(e) => handleEndpointBlur(section, e.target.value)}
                placeholder={endpointPlaceholder()}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
              {currentFormat === 'ollama' && (
                <p className="text-[10px] text-text-dim mt-1">
                  Local: <span className="font-mono">http://localhost:11434</span> &middot; Cloud: <span className="font-mono">https://api.ollama.com</span> (needs API key)
                </p>
              )}
              {currentFormat === 'claude' && (
                <p className="text-[10px] text-text-dim mt-1">
                  Get your key at <span className="font-mono">console.anthropic.com</span> &middot; Keys start with <span className="font-mono">sk-ant-</span>
                </p>
              )}
              {currentFormat === 'gemini' && (
                <p className="text-[10px] text-text-dim mt-1">
                  <span className="font-mono">https://generativelanguage.googleapis.com/v1beta</span> &middot; Key goes in URL
                </p>
              )}
            </div>
            <div>
              <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Format</label>
              <div className="flex border border-border overflow-hidden rounded">
                {availableFormats.map(fmt => (
                  <button
                    key={fmt}
                    onClick={() => handleApiFormatChange(section, fmt)}
                    className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${currentFormat === fmt ? 'bg-terminal text-surface font-bold' : 'bg-void text-text-dim hover:text-text-primary'}`}
                  >
                    {formatLabel(fmt)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Model Name</label>
              <input
                type="text"
                value={config.modelName}
                onChange={(e) => handleUpdateEndpoint(section, 'modelName', e.target.value)}
                placeholder={currentFormat === 'claude' ? 'claude-sonnet-4-20250514' : currentFormat === 'gemini' ? 'gemini-2.0-flash' : 'llama3'}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Key <span className="text-text-dim/60">(empty for local)</span></label>
              <input
                type="password"
                value={config.apiKey}
                onChange={(e) => handleUpdateEndpoint(section, 'apiKey', e.target.value)}
                placeholder={currentFormat === 'gemini' ? 'AIza...' : currentFormat === 'claude' ? 'sk-ant-...' : 'sk-...'}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
            </div>
            {section !== 'imageAI' && (
              <div>
                <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Thinking Effort</label>
                <div className="flex border border-border overflow-hidden rounded">
                  {(['off', 'low', 'medium', 'high', 'max'] as ThinkingEffort[]).map(level => (
                    <button
                      key={level}
                      onClick={() => updatePreset(activePreset!.id, { [section]: { ...config, thinkingEffort: level } })}
                      className={`flex-1 px-2 py-1.5 text-[9px] uppercase tracking-wider transition-colors focus:outline-none ${(config as EndpointConfig).thinkingEffort === level || (!(config as EndpointConfig).thinkingEffort && level === 'off')
                        ? 'bg-terminal text-void font-bold'
                        : 'bg-void text-text-dim hover:text-text-primary'
                      }`}
                      title={level === 'max' ? 'OpenAI & DeepSeek cap at High — Max sends High.' : undefined}
                    >
                      {level.charAt(0).toUpperCase() + level.slice(1)}
                    </button>
                  ))}
                </div>
                {(currentFormat === 'openai' || (config as EndpointConfig).thinkingEffort === 'max') && (config as EndpointConfig).thinkingEffort === 'max' && (
                  <p className="text-[8px] text-text-dim/70 mt-1">OpenAI/DeepSeek cap at High — Max sends High.</p>
                )}
              </div>
            )}

            <div className="pt-2">
              <button
                onClick={() => handleTest(section)}
                disabled={isTesting || !config.endpoint}
                className="w-full bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-2 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isTesting ? <><Loader2 size={14} className="animate-spin" /> Testing...</> : 'Test Connection'}
              </button>
              {result && (
                <div className={`flex items-center gap-2 text-xs px-3 py-2 border mt-2 ${result.ok ? 'border-terminal/30 text-terminal bg-terminal/5' : 'border-danger/30 text-danger bg-danger/5'}`}>
                  {result.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  {result.detail}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* ─── Preset Tabs ─── */}
      <div className="flex flex-col mb-6">
        <label className="text-text-dim text-xs uppercase tracking-widest mb-2 font-bold">AI Presets</label>
        <div className="flex items-center gap-1 border-b border-border overflow-x-auto pb-px">
          {settings.presets.map((p) => (
            <button
              key={p.id}
              onClick={() => { setActiveTab(p.id); setTestResults({}); }}
              className={`px-3 py-2 text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px ${activeTab === p.id
                ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                : 'text-text-dim border-transparent hover:text-text-primary hover:border-border'
                }`}
            >
              {p.name}
            </button>
          ))}
          <button
            onClick={handleAddPreset}
            className="px-3 py-2 text-text-dim hover:text-terminal transition-colors -mb-px border-b-2 border-transparent"
            title="Add Preset"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* ─── Active Preset Config ─── */}
      {activePreset && (
        <div className="mb-8 animate-in fade-in duration-200">
          <div className="flex gap-2 items-end mb-6">
            <div className="flex-1">
              <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Preset Name</label>
              <input
                type="text"
                value={activePreset.name}
                onChange={(e) => handleUpdatePresetName(e.target.value)}
                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-bold focus:border-terminal focus:outline-none"
                placeholder="e.g. Local Heavy"
              />
            </div>
            {settings.presets.length > 1 && (
              <button
                onClick={() => handleRemovePreset(activePreset.id)}
                className="bg-void border border-danger/40 hover:border-danger text-danger px-4 py-2 hover:bg-danger/10 transition-all flex border-dashed focus:outline-none"
                title="Delete this preset"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {renderEndpointConfig('storyAI', 'Story & Logic AI')}
          {renderEndpointConfig('summarizerAI', 'Summarizer & Context AI')}
          {renderEndpointConfig('imageAI', 'Image Generation AI')}
          {renderEndpointConfig('utilityAI', 'Utility AI (Context Recommender)')}
          {renderEndpointConfig('auxiliaryAI', 'Auxiliary AI (NPC Classification)')}

          <SamplingPanel preset={activePreset} onUpdate={handleUpdateSampling} />
        </div>
      )}
    </>
  );
}
