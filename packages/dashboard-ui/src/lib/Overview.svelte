<script lang="ts">
  import { app } from './store.svelte';
  import type { Chain, Endpoint } from './api';
  import EndpointRow from './EndpointRow.svelte';
  import Contracts from './Contracts.svelte';

  const relays = $derived(app.model?.chains.filter((c) => c.paraId === null) ?? []);
  const parachains = $derived(app.model?.chains.filter((c) => c.paraId !== null) ?? []);

  // Typed as tuples rather than inferred: a bare array literal of pairs widens to
  // (string | Endpoint[])[], and every field access inside the loop then has to be asserted.
  const sections = $derived<[string, (Chain | Endpoint)[]][]>(
    app.model
      ? [['Relay', relays], ['Parachains', parachains], ['Services', app.model.services]]
      : []
  );
</script>

{#if app.model}
  {#each sections as [title, entries] (title)}
    {#if entries.length}
      <h2 class="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-wide text-fg-tertiary">{title}</h2>
      <div
        class="grid grid-cols-[0.6rem_max-content_minmax(0,max-content)_max-content_max-content_1fr_max-content]
               items-center gap-x-5 overflow-hidden rounded-container bg-surface-container px-4 shadow-1">
        {#each entries as entry (entry.id)}
          <EndpointRow {entry} />
        {/each}
      </div>
    {/if}
  {/each}
{/if}

<Contracts />
