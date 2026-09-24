<script lang="ts">
  import { app } from './store.svelte';

  const ice = $derived(app.model?.ice ?? null);
  const health = $derived(ice ? app.health[ice.id] : undefined);
  let copied = $state<string | null>(null);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    copied = text;
    setTimeout(() => (copied = null), 1200);
  }
</script>

{#if ice}
  <h2 class="mb-2 mt-6 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-fg-tertiary">
    <span
      class="h-2 w-2 rounded-full
             {health?.status === 'ok' ? 'bg-status-ok' : health?.status === 'down' ? 'bg-status-err' : 'bg-fg-tertiary'}"
      title={health?.error ?? health?.status ?? 'not probed yet'}
    ></span>
    TURN / STUN
  </h2>
  <div class="overflow-hidden rounded-container bg-surface-container shadow-1">
    {#each ice.servers as s (s.id)}
      <div class="flex items-center gap-3 border-b border-divider px-4 py-2.5">
        <span class="w-40 shrink-0 text-sm font-medium text-fg-primary">{s.label}</span>
        <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary" title={s.url}>{s.url}</code>
        <button
          class="shrink-0 cursor-pointer text-xs text-fg-tertiary transition-colors hover:text-fg-primary"
          onclick={() => copy(s.url)}>{copied === s.url ? 'copied' : 'copy'}</button>
      </div>
    {/each}
    <!-- The relay only accepts credentials DUB minted; a client never configures a password. -->
    <div class="flex items-center gap-3 px-4 py-2.5">
      <span class="w-40 shrink-0 text-sm font-medium text-fg-primary">Credentials</span>
      <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary" title={ice.credentialsUrl}>
        POST {ice.credentialsUrl}
      </code>
      <span class="shrink-0 text-xs text-fg-tertiary">Bearer DUB JWT</span>
    </div>
  </div>
{/if}
