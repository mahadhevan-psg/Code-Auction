import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../socket/socket';

/**
 * Loads data, optionally polls, and re-fetches (debounced) when any of the given socket events fire.
 * Keeps the previous data on screen while refreshing, so tables never flash empty.
 */
export function useLoad<T>(
  fetcher: () => Promise<T>,
  opts: { interval?: number; events?: string[]; deps?: unknown[]; enabled?: boolean } = {}
) {
  const { interval, events = [], deps = [], enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const d = await fetcherRef.current();
      if (alive.current) { setData(d); setError(null); }
    } catch (e: any) {
      if (alive.current) setError(e?.message || 'Failed to load');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  const debounced = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, 250);
  }, [reload]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    setLoading(true);
    reload();
    const iv = interval ? setInterval(reload, interval) : null;
    for (const ev of events) socket.on(ev, debounced);
    return () => {
      alive.current = false;
      if (iv) clearInterval(iv);
      if (timer.current) clearTimeout(timer.current);
      for (const ev of events) socket.off(ev, debounced);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, interval, events.join('|'), ...deps]);

  return { data, error, loading, reload, setData };
}
