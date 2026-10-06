import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket/socket';
import { api } from '../services/api';
import type { EventState } from '../types';

const INITIAL: EventState = {
  roundId: 1, roundNumber: 1, totalRounds: 2, state: 'WAITING', remainingSeconds: 0, paused: false,
  priorityDuration: 180, codingDuration: 600, phaseEndsAt: null, serverNow: Date.now(), allocationError: null
};

/**
 * Server-authoritative event state plus a smooth, drift-free countdown.
 * The countdown is computed from the server's absolute `phaseEndsAt` and a clock offset measured
 * on every message, so a wrong client clock cannot shift the timer.
 */
export function useEventState() {
  const [state, setState] = useState<EventState>(INITIAL);
  const [connected, setConnected] = useState(socket.connected);
  const [remaining, setRemaining] = useState(0);
  const offsetRef = useRef(0); // serverNow - clientNow
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const syncOffset = (serverNow?: number) => {
      if (typeof serverNow === 'number') offsetRef.current = serverNow - Date.now();
    };

    const onState = (s: EventState) => { syncOffset(s.serverNow); setState(s); };
    const onTimer = (t: { roundId: number; remainingSeconds: number; paused: boolean; serverNow: number; phaseEndsAt: number | null }) => {
      syncOffset(t.serverNow);
      setState(prev => ({ ...prev, roundId: t.roundId, remainingSeconds: t.remainingSeconds, paused: t.paused, phaseEndsAt: t.phaseEndsAt }));
    };
    const onConnect = () => {
      setConnected(true);
      api.getCurrentState().then(onState).catch(() => {});
    };
    const onDisconnect = () => setConnected(false);

    socket.on('round:state', onState);
    socket.on('round:timer', onTimer);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    api.getCurrentState().then(onState).catch(() => {});

    return () => {
      socket.off('round:state', onState);
      socket.off('round:timer', onTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  useEffect(() => {
    const compute = () => {
      const s = stateRef.current;
      if (s.state !== 'PRIORITY_SELECTION' && s.state !== 'CODING') return 0;
      if (s.paused || !s.phaseEndsAt) return Math.max(0, s.remainingSeconds);
      return Math.max(0, Math.ceil((s.phaseEndsAt - (Date.now() + offsetRef.current)) / 1000));
    };
    setRemaining(compute());
    const id = setInterval(() => setRemaining(compute()), 250);
    return () => clearInterval(id);
  }, [state.phaseEndsAt, state.paused, state.state, state.remainingSeconds]);

  return { state, remaining, connected };
}
