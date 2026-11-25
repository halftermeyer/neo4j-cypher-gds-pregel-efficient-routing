import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { Device, Flow, Topology } from "./lib/topology";

export interface Ctx {
  db: string;
  topo: Topology | null;
  devices: Device[];
  ready: boolean;                    // topology ingested
  setTopo: (t: Topology | null) => void;
  version: number;                   // bumps after every data change so panels can refresh
  bump: () => void;
}
const C = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(C);

export function AppProvider({ db, children }: { db: string; children: ReactNode }) {
  const [topo, setTopo] = useState<Topology | null>(null);
  const devices = topo?.devices ?? [];
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  return <C.Provider value={{ db, topo, devices, ready: devices.length > 0, setTopo, version, bump }}>{children}</C.Provider>;
}

/** Async action with busy/error state, for buttons. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }, []);
  return { busy, error, run };
}
export type { Flow };
