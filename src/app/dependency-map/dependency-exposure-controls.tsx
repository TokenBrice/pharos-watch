"use client";

import { useState } from "react";
import Link from "next/link";
import dependencyMapContent from "./content.json";

const content = dependencyMapContent.exposure;

export interface ExposureRootOption { id: string; label: string }
export function DependencyExposureControls({ roots, options, onAdd, onRemove, onReset, onShare }: {
  roots: readonly string[]; options: readonly ExposureRootOption[];
  onAdd: (id: string) => void; onRemove: (id: string) => void; onReset: () => void; onShare: () => void;
}) {
  const [draft, setDraft] = useState("");
  return <aside className="space-y-4 rounded-lg border border-border p-4" aria-label="Exposure roots">
    <p className="text-sm text-muted-foreground">{content.description}</p>
    <h3 className="font-semibold">{content.roots}</h3>
    {roots.length ? <ul className="space-y-1">{roots.map(id => <li key={id} className="flex items-center justify-between gap-2"><span>{options.find(option => option.id === id)?.label ?? id}</span><button type="button" className="pharos-focus-ring min-h-11 rounded px-2 text-sm" onClick={() => onRemove(id)} aria-label={`Remove root ${id}`}>{content.remove}</button></li>)}</ul> : <p className="text-sm text-muted-foreground">{content.empty}</p>}
    <label className="block text-sm" htmlFor="exposure-root-picker">{content.add}</label>
    <select id="exposure-root-picker" value={draft} onChange={event => setDraft(event.target.value)} className="min-h-11 w-full rounded border border-border bg-background px-2 text-sm"><option value="">{content.choose}</option>{options.filter(option => !roots.includes(option.id)).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
    <button type="button" disabled={!draft} className="pharos-focus-ring min-h-11 rounded border border-border px-3 text-sm disabled:opacity-50" onClick={() => { if (draft) { onAdd(draft); setDraft(""); } }}>{content.trace}</button>
    <div className="flex gap-2"><button type="button" className="pharos-focus-ring min-h-11 rounded px-3 text-sm" onClick={onShare}>{content.share}</button><button type="button" className="pharos-focus-ring min-h-11 rounded px-3 text-sm" onClick={onReset}>{content.reset}</button></div>
    <details className="text-sm"><summary className="pharos-focus-ring min-h-11 cursor-pointer py-3">{content.history}</summary><p className="text-muted-foreground">{content.historyDescription}</p><Link href={content.historyLink.href} className="inline-flex min-h-11 items-center underline">{content.historyLink.label}</Link></details>
  </aside>;
}
