<script lang="ts">
  import { onDestroy } from 'svelte';
  import { fetchLogGroups, logStream } from './api';
  import type { LogGroups } from './api';
  import { logIdOf, fragmentFor } from './route';

  let groups = $state<LogGroups | null>(null);
  let active = $state<string | null>(null);
  let lines = $state<{ text: string; sev: '' | 'e' | 'w' }[]>([]);
  let pane = $state<HTMLElement | null>(null);
  let source: EventSource | null = null;

  // Which log, from `#logs/<id>` — so a reload reopens the stream you were reading and a link
  // to one node's log is shareable. App.svelte owns the first fragment segment (the tab); this
  // owns the second. Validated against the whitelist the API returned, never trusted: the
  // fragment is user-editable, and an id that no longer exists would open a dead stream.
  const idFromHash = () => logIdOf(location.hash);

  fetchLogGroups().then((g) => {
    groups = g;
    const known = [...g.chains, ...g.services, ...g.scripts];
    const asked = idFromHash();
    const first = (asked && known.includes(asked) ? asked : null) ?? known[0];
    if (first) follow(first);
  });

  // Back/forward, or a pasted link, while the tab is already open.
  $effect(() => {
    const sync = () => {
      const asked = idFromHash();
      if (asked && asked !== active && groups) {
        const known = [...groups.chains, ...groups.services, ...groups.scripts];
        if (known.includes(asked)) follow(asked);
      }
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  });

  function follow(id: string) {
    active = id;
    // Replaced, not pushed: clicking through ten logs should not put ten entries between you
    // and the page you came from. The tab switch in App.svelte is the real history step.
    const target = fragmentFor('logs', id);
    if (location.hash !== target) history.replaceState(null, '', target);
    lines = [];
    source?.close();
    source = logStream(id);
    source.onmessage = (ev) => {
      const sev = /error|panic|fatal/i.test(ev.data) ? 'e' : /warn/i.test(ev.data) ? 'w' : '';
      const stick = pane && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
      lines.push({ text: ev.data, sev });
      if (lines.length > 2000) lines.splice(0, lines.length - 2000);
      if (stick) requestAnimationFrame(() => pane && (pane.scrollTop = pane.scrollHeight));
    };
  }

  onDestroy(() => source?.close());

  const sections = $derived(groups
    ? ([['Chains', groups.chains], ['Services', groups.services], ['One-off scripts', groups.scripts]] as const)
    : []);
</script>

{#if groups && !groups.chains.length && !groups.services.length && !groups.scripts.length}
  <div class="p-8 text-center text-fg-tertiary">No logs yet — is the network running?</div>
{:else if groups}
  <div class="grid min-h-[60vh] grid-cols-[260px_1fr] gap-3">
    <div class="max-h-[75vh] overflow-y-auto rounded-container bg-surface-container p-2 shadow-1">
      {#each sections as [title, ids]}
        {#if ids.length}
          <div class="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary">{title}</div>
          {#each ids as id (id)}
            <button
              class="block w-full cursor-pointer rounded-medium px-3 py-1.5 text-left text-[13px] transition-colors
                     {id === active
                       ? 'bg-surface-nested font-medium text-fg-primary'
                       : 'text-fg-secondary hover:bg-selection-hover'}"
              onclick={() => follow(id)}>{id}</button>
          {/each}
        {/if}
      {/each}
    </div>
    <div bind:this={pane}
      class="max-h-[75vh] overflow-auto whitespace-pre-wrap break-all rounded-container bg-surface-container p-3.5 font-mono text-xs leading-relaxed text-fg-secondary shadow-1">
      {#each lines as line}
        <div class={line.sev === 'e' ? 'text-status-err' : line.sev === 'w' ? 'text-status-warn' : ''}>{line.text}</div>
      {/each}
    </div>
  </div>
{/if}
