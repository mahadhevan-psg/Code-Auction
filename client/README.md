# Client

React 19 + TypeScript + Vite. See the [project README](../README.md) for how to run and operate the event.

```bash
npm run dev     # http://localhost:5173, proxies /api and /socket.io to :4000
                # VITE_PROXY_TARGET=http://host:port npm run dev   to point elsewhere
npm run build   # type-check + production bundle into dist/ (served by the server)
npm run lint
```

Layout

- `src/pages/` — `Login`, `FirstYearDashboard`, `SeniorDashboard` (lazy-loaded with Monaco), `AdminDashboard` + `admin/*` panels
- `src/hooks/useProctor.tsx` — exam-mode enforcement and flag reporting
- `src/hooks/useEventState.ts` — server-authoritative state and drift-free countdown
- `src/components/ui.tsx` — shared primitives (toasts, modals, badges, tabs…)
- `src/index.css` — design tokens (dark/light) and component classes
