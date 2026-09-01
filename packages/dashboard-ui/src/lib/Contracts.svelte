<script lang="ts">
  import { fetchAddresses } from './api';
  import type { Addresses } from './api';

  let addresses = $state<Addresses | null>(null);
  let copied = $state<string | null>(null);
  fetchAddresses().then((a) => (addresses = a));

  async function copy(addr: string) {
    await navigator.clipboard.writeText(addr);
    copied = addr;
    setTimeout(() => (copied = null), 1200);
  }
</script>

{#if addresses?.dotns}
  <h2 class="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-wide text-fg-tertiary">
    DotNS contracts on Asset Hub
  </h2>
  <div class="overflow-hidden rounded-container bg-surface-container shadow-1">
    {#each Object.entries(addresses.dotns) as [name, addr] (name)}
      <div class="flex items-center gap-3 border-b border-divider px-4 py-2.5 last:border-0">
        <span class="w-64 shrink-0 truncate text-sm font-medium text-fg-primary">{name}</span>
        <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary">{addr}</code>
        <button
          class="shrink-0 cursor-pointer text-xs text-fg-tertiary transition-colors hover:text-fg-primary"
          onclick={() => copy(addr)}>{copied === addr ? 'copied' : 'copy'}</button>
      </div>
    {/each}
  </div>
{:else if addresses}
  <div class="p-8 text-center text-fg-tertiary">
    No DotNS address manifest in this workspace — `ppn fetch` downloads it for genesis networks.
  </div>
{/if}
