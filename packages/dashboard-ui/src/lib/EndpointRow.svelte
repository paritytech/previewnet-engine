<script lang="ts">
  import type { Endpoint, Chain } from './api';
  import { app } from './store.svelte';
  import UpgradePanel from './UpgradePanel.svelte';

  let { entry }: { entry: Endpoint | Chain } = $props();
  const health = $derived(app.health[entry.id]);
  const upgradeChain = $derived(
    entry.id === 'relay-alice' ? 'relay' : !entry.id.startsWith('relay-') && 'paraId' in entry ? entry.id : null
  );
  const upgradeable = $derived((app.actions?.enabled ?? false) && upgradeChain !== null);
  const href = $derived(entry.protocol === 'ws' ? (entry.links.pjs ?? null) : entry.url);

  // What this chain is running now, probed rather than looked up: after a live upgrade the
  // spec version on the node and the WASM in bin/ disagree, and this is the one that matters.
  const spec = $derived(
    health?.runtime ? `${health.runtime.specName}/${health.runtime.specVersion}` : null
  );
  // system_version is "1.19.0-abc123def" — the commit is noise in a table this dense, and
  // provenance's own version column carries the full string for anyone who wants it.
  const client = $derived(health?.clientVersion?.split('-')[0] ?? null);

  let copied = $state(false);
  let upgradeOpen = $state(false);

  async function copy() {
    await navigator.clipboard.writeText(entry.url);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

<!-- A subgrid line of the section's table: columns are sized by the section (max-content), so
     names never truncate, and URLs, heights and versions each align as a column. The parent's
     1fr sits *before* the last column, so the slack lands in the middle and the links and
     action buttons are flushed to the right edge instead of trailing the version text. -->
<div class="col-span-7 grid grid-cols-subgrid items-center border-b border-divider py-2.5 last:border-0">
  <span
    class="h-2 w-2 rounded-full
           {health?.status === 'ok' ? 'bg-status-ok' : health?.status === 'down' ? 'bg-status-err' : 'bg-fg-tertiary'}"
  ></span>
  {#if href}
    <a class="inline-flex items-center gap-1 text-sm font-medium text-fg-primary underline-offset-3 hover:underline"
       href={href} target="_blank" rel="noreferrer"
       title={entry.protocol === 'ws' ? 'open in polkadot.js Apps' : 'open'}>
      {entry.label}
      <svg class="h-3 w-3 text-fg-tertiary" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      </svg>
    </a>
  {:else}
    <span class="text-sm font-medium text-fg-primary">{entry.label}</span>
  {/if}
  <span class="inline-flex min-w-0 items-center gap-1.5">
    <code class="truncate font-mono text-xs text-fg-secondary" title={entry.url}>{entry.url}</code>
    <button
      class="shrink-0 cursor-pointer rounded p-0.5 text-fg-tertiary transition-colors hover:text-fg-primary"
      onclick={copy} title="copy">
      {#if copied}
        <svg class="h-3.5 w-3.5 text-status-ok" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      {:else}
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
        </svg>
      {/if}
    </button>
  </span>
  <span class="text-right text-xs tabular-nums text-fg-tertiary">
    {#if health?.status === 'ok' && health.block !== undefined}#{health.block.toLocaleString()}
    {:else if health?.status === 'down'}<span class="text-status-err">down</span>{/if}
  </span>
  <!-- Runtime and node, for chains that answered. Titled rather than expanded: the full
       triple (impl/transaction version, the client's git hash) belongs in a tooltip, not in
       a row that has to stay one line on a laptop. -->
  <span class="inline-flex items-center gap-2 text-xs text-fg-tertiary">
    {#if spec}
      <code class="font-mono text-fg-secondary"
            title="runtime {health!.runtime!.specName} spec {health!.runtime!.specVersion}, impl {health!.runtime!.implVersion}, tx {health!.runtime!.transactionVersion}"
      >{spec}</code>
    {/if}
    {#if client}
      <code class="font-mono" title="node binary {health!.clientVersion}">{client}</code>
    {/if}
  </span>
  <span></span>
  <span class="inline-flex items-center justify-end gap-3">
    {#each Object.entries(entry.links ?? {}) as [kind, url]}
      <a class="text-xs text-fg-link underline underline-offset-3 hover:text-fg-primary"
         href={url} target="_blank" rel="noreferrer">{kind}</a>
    {/each}
    {#if upgradeable}
      <button
        class="cursor-pointer rounded-medium bg-surface-nested px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-selection-hover hover:text-fg-primary"
        onclick={() => (upgradeOpen = !upgradeOpen)}>runtime-upgrade</button>
    {/if}
  </span>
  {#if upgradeOpen && upgradeable}
    <div class="col-span-7 pb-3 pl-6">
      <UpgradePanel chain={upgradeChain!} />
    </div>
  {/if}
</div>
