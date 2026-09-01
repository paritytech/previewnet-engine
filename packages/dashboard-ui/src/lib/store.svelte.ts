// One reactive store fed by the API; every component reads from here.
import { fetchActions, fetchModel, fetchHealth, fetchProvenance } from './api';
import type { ActionsState, Model, Health, Provenance } from './api';

export const app = $state({
  model: null as Model | null,
  health: {} as Record<string, Health>,
  provenance: null as Provenance | null,
  actions: null as ActionsState | null,
  error: null as string | null,
});

export async function init(): Promise<void> {
  try {
    app.model = await fetchModel();
    app.provenance = await fetchProvenance().catch(() => null);
    app.actions = await fetchActions().catch(() => null);
    await refreshHealth();
    setInterval(refreshHealth, 5000);
  } catch (e) {
    app.error = (e as Error).message;
  }
}

async function refreshHealth(): Promise<void> {
  try {
    const entries = await fetchHealth();
    app.health = Object.fromEntries(entries.map((e) => [e.id, e]));
  } catch {
    /* sidecar restarting; next tick retries */
  }
}
