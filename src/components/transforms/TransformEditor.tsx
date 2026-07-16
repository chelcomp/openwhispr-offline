import React, { useState, useEffect, useRef } from "react";
import { X, Pencil, Trash2 } from "lucide-react";
import type { Transform, TransformRules } from "../../stores/settingsStore";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { cn } from "../lib/utils";

const DEFAULT_RULES: TransformRules = {
  makeMoreConcise: false,
  rewordForClarity: false,
  reorderForReadability: false,
  addStructureForReadability: false,
  removeFrustration: false,
};

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        checked ? "bg-foreground" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out",
          checked ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  );
}

function RuleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-3 border-b border-border/20 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground leading-snug">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{description}</p>
        )}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function HotkeyCapture({
  value,
  onChange,
  takenHotkeys,
}: {
  value: string;
  onChange: (hotkey: string) => void;
  takenHotkeys: string[];
}) {
  const [isListening, setIsListening] = useState(false);
  const [conflict, setConflict] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isListening) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setIsListening(false);
        return;
      }

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Control");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      // e.metaKey = Win key on Windows, Cmd on macOS. "Super" is the correct
      // Electron accelerator name for both (Win on Windows, Cmd on macOS).
      if (e.metaKey) parts.push("Super");

      // Filter out standalone modifier key presses. On Windows the Win key
      // reports e.key as "Meta" or "OS" depending on the Electron/Chrome version.
      const MODIFIER_KEYS = new Set([
        "Control", "Alt", "Shift", "Meta", "OS", "Super", "Hyper", "Win",
      ]);

      if (!MODIFIER_KEYS.has(e.key) && parts.length > 0) {
        // Use e.code for the physical key so the result is layout-independent
        // (Alt+1 on a Portuguese keyboard would give e.key="!" but e.code="Digit1").
        let keyName: string;
        if (/^Digit\d$/.test(e.code)) {
          keyName = e.code.slice(-1); // "Digit1" → "1"
        } else if (/^Key[A-Z]$/.test(e.code)) {
          keyName = e.code.slice(-1); // "KeyA" → "A"
        } else if (e.key.length === 1) {
          keyName = e.key.toUpperCase();
        } else {
          keyName = e.key; // F1, Space, Backspace, etc.
        }

        const hotkey = [...parts, keyName].join("+");
        const taken = takenHotkeys.some(
          (h) => h.toLowerCase() === hotkey.toLowerCase()
        );
        setConflict(taken);
        if (!taken) {
          onChange(hotkey);
          setIsListening(false);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isListening, takenHotkeys, onChange]);

  const parts = value ? formatHotkeyLabel(value).split("+") : [];

  return (
    <div>
      <div
        ref={ref}
        className={cn(
          "flex items-center justify-between px-3 py-2.5 rounded-lg border bg-background transition-colors",
          isListening
            ? "border-primary/60 ring-2 ring-primary/20"
            : "border-border/40 hover:border-border/70 cursor-pointer"
        )}
        onClick={() => { setIsListening(true); setConflict(false); }}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          {isListening ? (
            <span className="text-sm text-muted-foreground animate-pulse">
              Press a key combination…
            </span>
          ) : parts.length > 0 ? (
            parts.map((p, i) => (
              <kbd
                key={i}
                className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium rounded border border-border/50 bg-muted/60 text-foreground leading-none"
              >
                {p}
              </kbd>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">Click to set shortcut</span>
          )}
        </div>
        {!isListening && (
          <Pencil size={13} className="shrink-0 text-muted-foreground" />
        )}
      </div>
      {conflict && (
        <p className="text-xs text-destructive mt-1">
          This shortcut is already in use by another transform.
        </p>
      )}
      {isListening && (
        <p className="text-xs text-muted-foreground mt-1">
          Press Esc to cancel.
        </p>
      )}
    </div>
  );
}

interface TransformEditorProps {
  transform: Transform | null;
  existingHotkeys: string[];
  onSave: (transform: Transform) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export default function TransformEditor({
  transform,
  existingHotkeys,
  onSave,
  onDelete,
  onClose,
}: TransformEditorProps) {
  const [name, setName] = useState(transform?.name ?? "");
  const [description, setDescription] = useState(transform?.description ?? "");
  const [hotkey, setHotkey] = useState(transform?.hotkey ?? "");
  const [enabled, setEnabled] = useState(transform?.enabled ?? true);
  const [rules, setRules] = useState<TransformRules>(transform?.rules ?? { ...DEFAULT_RULES });
  const [customPrompt, setCustomPrompt] = useState(transform?.customPrompt ?? "");
  const [includeActiveApp, setIncludeActiveApp] = useState(transform?.includeActiveApp ?? false);
  const [richText, setRichText] = useState(transform?.richText ?? false);

  const setRule = (key: keyof TransformRules) => (val: boolean) =>
    setRules((prev) => ({ ...prev, [key]: val }));

  const canSave = name.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      id: transform?.id ?? generateId(),
      name: name.trim(),
      description: description.trim(),
      hotkey,
      enabled,
      rules,
      customPrompt,
      includeActiveApp,
      richText,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative flex w-full max-w-2xl max-h-[90vh] rounded-2xl border border-border/40 bg-background shadow-2xl overflow-hidden">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <X size={16} />
        </button>

        {/* Left column */}
        <div className="flex flex-col w-56 shrink-0 border-r border-border/20 p-5 gap-4 overflow-y-auto">
          <div>
            <input
              type="text"
              placeholder="Transform name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-transparent text-xl font-semibold text-foreground placeholder:text-muted-foreground/40 outline-none border-none"
              autoFocus
            />
          </div>

          {hotkey && (
            <div className="flex items-center gap-1 flex-wrap">
              {formatHotkeyLabel(hotkey)
                .split("+")
                .map((p, i) => (
                  <kbd
                    key={i}
                    className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border border-border/40 bg-muted/60 text-muted-foreground leading-none"
                  >
                    {p}
                  </kbd>
                ))}
              <span className="text-xs text-muted-foreground">to use</span>
            </div>
          )}

          <textarea
            placeholder="Short description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full bg-transparent text-sm text-foreground/80 placeholder:text-muted-foreground/40 outline-none border-none resize-none leading-relaxed"
          />

          <div className="flex-1" />

          <div className="flex items-center justify-between pt-2 border-t border-border/20">
            <span className="text-xs text-muted-foreground">Enabled</span>
            <Toggle checked={enabled} onChange={setEnabled} />
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col flex-1 overflow-y-auto">
          <div className="p-5 space-y-6">
            {/* Hotkey */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Choose a keyboard shortcut
              </h3>
              <HotkeyCapture
                value={hotkey}
                onChange={setHotkey}
                takenHotkeys={existingHotkeys}
              />
            </section>

            {/* Rules */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Select rules
              </h3>
              <div className="rounded-xl border border-border/30 bg-muted/20 px-3">
                <RuleRow
                  label="Make more concise"
                  checked={rules.makeMoreConcise}
                  onChange={setRule("makeMoreConcise")}
                />
                <RuleRow
                  label="Reword for clarity"
                  checked={rules.rewordForClarity}
                  onChange={setRule("rewordForClarity")}
                />
                <RuleRow
                  label="Reorder for readability"
                  checked={rules.reorderForReadability}
                  onChange={setRule("reorderForReadability")}
                />
                <RuleRow
                  label="Add structure for readability"
                  checked={rules.addStructureForReadability}
                  onChange={setRule("addStructureForReadability")}
                />
                <RuleRow
                  label="Remove frustration, anxiety, or any bad emotion from the text. Always write and transform texts in a way which is direct, polite, professional, and helpful. Always replace bad words with something more polite."
                  checked={rules.removeFrustration}
                  onChange={setRule("removeFrustration")}
                />
              </div>
            </section>

            {/* Context */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Context
              </h3>
              <div className="rounded-xl border border-border/30 bg-muted/20 px-3">
                <RuleRow
                  label="Include application name"
                  description="Sends the active application name to the AI so it can format the output accordingly (e.g. Slack, Notion, Gmail)"
                  checked={includeActiveApp}
                  onChange={setIncludeActiveApp}
                />
                <RuleRow
                  label="Rich text output"
                  description="Converts the result to HTML before pasting. Text pasted into apps like Slack, Notion, or Gmail will render bold, italic, and lists instead of showing raw symbols."
                  checked={richText}
                  onChange={setRichText}
                />
              </div>
            </section>

            {/* Custom prompt */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Customize your prompt
              </h3>
              <textarea
                placeholder="Add any additional instructions for the AI…"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                rows={4}
                className="w-full rounded-xl border border-border/30 bg-muted/20 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 resize-none leading-relaxed transition-colors"
              />
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 px-5 py-4 border-t border-border/20 mt-auto shrink-0">
            {onDelete && (
              <button
                onClick={onDelete}
                className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                title="Delete transform"
              >
                <Trash2 size={15} />
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-4 py-1.5 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
