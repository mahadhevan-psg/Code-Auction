import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import type { Difficulty, SubmissionStatus } from '../types';

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) and ISO strings both parse here. */
export function parseTs(ts?: string | null): number {
  if (!ts) return 0;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  return Date.parse(iso) || 0;
}

export function timeOnly(ts?: string | null): string {
  const t = parseTs(ts);
  return t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function timeAgo(ts?: string | null): string {
  const t = parseTs(ts);
  if (!t) return '—';
  const d = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */
type ToastKind = 'ok' | 'err' | 'warn' | 'info';
interface ToastItem { id: number; kind: ToastKind; text: string }
const ToastCtx = createContext<(kind: ToastKind, text: string, ms?: number) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: ToastKind, text: string, ms = 4500) => {
    const id = ++seq.current;
    setItems(prev => [...prev.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), ms);
  }, []);

  const Icon = { ok: CheckCircle2, err: XCircle, warn: AlertTriangle, info: Info };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map(t => {
          const I = Icon[t.kind];
          return (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <I size={17} />
              <span style={{ flex: 1 }}>{t.text}</span>
              <button className="btn-ghost btn-sm btn-icon btn" style={{ height: 22, width: 22 }} onClick={() => setItems(p => p.filter(x => x.id !== t.id))} aria-label="Dismiss">
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
};

/* ------------------------------------------------------------------ */
/* Modal / confirm                                                     */
/* ------------------------------------------------------------------ */
export const Modal: React.FC<{
  title: React.ReactNode;
  onClose?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'md' | 'lg';
  description?: React.ReactNode;
}> = ({ title, onClose, children, footer, size = 'md', description }) => {
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose?.(); }} role="dialog" aria-modal="true">
      <div className={`modal ${size === 'lg' ? 'modal-lg' : ''}`}>
        <div className="modal-head">
          <h3 style={{ fontSize: 17 }}>{title}</h3>
          {description && <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>{description}</p>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

export const ConfirmModal: React.FC<{
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ title, body, confirmLabel, danger, busy, onConfirm, onCancel }) => (
  <Modal
    title={title}
    onClose={onCancel}
    footer={
      <>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy && <Loader2 size={15} className="spin" />}{confirmLabel}
        </button>
      </>
    }
  >
    <div className="muted" style={{ fontSize: 14 }}>{body}</div>
  </Modal>
);

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */
export const Spinner: React.FC<{ size?: number }> = ({ size = 18 }) => <Loader2 size={size} className="spin" />;

export const Empty: React.FC<{ icon?: React.ReactNode; title: string; hint?: React.ReactNode; action?: React.ReactNode }> = ({ icon, title, hint, action }) => (
  <div className="empty">
    {icon}
    <h4>{title}</h4>
    {hint && <p style={{ fontSize: 13, maxWidth: 360 }}>{hint}</p>}
    {action}
  </div>
);

export const Banner: React.FC<{ kind: 'info' | 'ok' | 'warn' | 'err'; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }> = ({ kind, icon, children, action }) => {
  const defaults = { info: <Info size={17} />, ok: <CheckCircle2 size={17} />, warn: <AlertTriangle size={17} />, err: <XCircle size={17} /> };
  return (
    <div className={`banner banner-${kind}`}>
      {icon ?? defaults[kind]}
      <div className="banner-body" style={{ flex: 1 }}>{children}</div>
      {action}
    </div>
  );
};

export const StatCard: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ReactNode; tone?: 'ok' | 'warn' | 'err' | 'accent'; progress?: number }> = ({ label, value, sub, icon, tone, progress }) => (
  <div className="card stat">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span className="eyebrow">{label}</span>
      {icon && <span style={{ color: tone ? `var(--${tone === 'accent' ? 'accent-text' : tone})` : 'var(--text-3)' }}>{icon}</span>}
    </div>
    <div className="stat-value">{value}</div>
    {progress !== undefined && <div className="progress"><span style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} /></div>}
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

export const DifficultyBadge: React.FC<{ difficulty: Difficulty; weight?: number }> = ({ difficulty, weight }) => (
  <span className={`badge diff-${difficulty.toLowerCase()}`}>
    {difficulty}{weight !== undefined && <span className="num" style={{ opacity: 0.8 }}>×{weight}</span>}
  </span>
);

export const StatusBadge: React.FC<{ status: SubmissionStatus | string }> = ({ status }) => {
  const kind =
    status === 'Accepted' ? 'badge-ok'
    : status === 'Pending' || status === 'Judging' ? 'badge-info'
    : status === 'Time Limit Exceeded' ? 'badge-warn'
    : 'badge-err';
  return (
    <span className={`badge ${kind}`}>
      {(status === 'Pending' || status === 'Judging') && <Loader2 size={11} className="spin" />}
      {status}
    </span>
  );
};

export const Tabs: React.FC<{ value: string; onChange: (v: string) => void; items: Array<{ id: string; label: string; count?: number; alert?: boolean; icon?: React.ReactNode }> }> = ({ value, onChange, items }) => (
  <div className="tabs" role="tablist">
    {items.map(it => (
      <button key={it.id} className="tab" role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}>
        {it.icon}{it.label}
        {it.count !== undefined && it.count > 0 && <span className={`tab-count ${it.alert ? 'tab-count-alert' : ''}`}>{it.count}</span>}
      </button>
    ))}
  </div>
);

export const Field: React.FC<{ label: string; hint?: React.ReactNode; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="field">
    <span className="label">{label}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>
);

export const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }> = ({ checked, onChange, label, hint }) => (
  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
    <span className="switch" style={{ marginTop: 1 }}><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /></span>
    <span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
      {hint && <span className="hint" style={{ display: 'block' }}>{hint}</span>}
    </span>
  </label>
);

/** Run an async action with a busy flag and toast on failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(key);
    try {
      const r = await fn();
      if (okMsg) toast('ok', okMsg);
      return r;
    } catch (e: any) {
      toast('err', e?.message || 'Something went wrong');
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return useMemo(() => ({ busy, run }), [busy, run]);
}
