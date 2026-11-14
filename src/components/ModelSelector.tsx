import { Cpu } from 'lucide-react';
import type { AIModelOption } from '../types/assistant';

interface ModelSelectorProps {
  models: AIModelOption[];
  value: string;
  onChange: (model: string) => void;
  className?: string;
  modelAvailable: boolean;
}

export function ModelSelector({ models, value, onChange, className = '', modelAvailable }: ModelSelectorProps) {
  const isSelectable = modelAvailable && models.length > 0;
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <label className="inline-flex max-w-[145px] min-w-0 items-center gap-1 rounded-lg border border-white/[0.08] bg-[#111827] px-2 py-1.5 text-xs text-[#F8FAFC]">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-[#60A5FA]" aria-hidden="true" />
        <span className="sr-only">Choose a hosted AI model from a configured provider</span>
        <select
          aria-label="AI model"
          value={isSelectable ? value : ''}
          disabled={!isSelectable}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 max-w-[112px] appearance-none bg-transparent text-ellipsis focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
          title={isSelectable
            ? models.find((model) => model.id === value)?.description || 'Configured AI model'
            : 'AI is not connected. Add one or more provider API keys to .env and restart the API.'}
        >
          {!isSelectable && <option value="" className="bg-[#111827] text-[#F8FAFC]">Provider key needed</option>}
          {isSelectable && models.map((model) => (
            <option key={model.id} value={model.id} className="bg-[#111827] text-[#F8FAFC]">
              {model.name}
            </option>
          ))}
        </select>
      </label>
      {isSelectable ? (
        <span
          title="Free usage and pricing depend on the provider account and selected model. Check the provider dashboard before use."
          className="whitespace-nowrap text-[10px] text-[#94A3B8]"
        >
          Limits vary
        </span>
      ) : <span className="whitespace-nowrap text-[10px] text-[#FBBF24]">Provider key needed</span>}
    </div>
  );
}
