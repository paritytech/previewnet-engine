<script lang="ts">
  import { app, init } from './lib/store.svelte';
  import Overview from './lib/Overview.svelte';
  import Provenance from './lib/Provenance.svelte';
  import Logs from './lib/Logs.svelte';
  import { tabOf, fragmentFor } from './lib/route';

  // Contracts render inside the overview: they are part of "what this network is", not a
  // separate destination.
  const views = { overview: Overview, provenance: Provenance, logs: Logs } as const;
  type View = keyof typeof views;

  // The open tab lives in the URL fragment, so a reload comes back where you were and a link
  // to "the logs tab" is a link someone else can open.
  //
  // The fragment and not a path: this SPA is served as one index.html, at `/` locally and
  // behind nginx on a server. A path like /logs would miss the static handler and 404, and on
  // a server it would sit in the same namespace as the chain routes the model owns
  // (/asset-hub, /relay/alice, /ipfs). A fragment never reaches either.
  //
  // Shape is `#<tab>` with an optional second segment the tab itself owns — Logs reads
  // `#logs/<id>` to reopen the stream you were reading. Parsing lives in lib/route.ts.
  const names = Object.keys(views) as View[];
  const current = () => tabOf(location.hash, names, 'overview');

  let view = $state<View>(current());
  const ViewComponent = $derived(views[view]);

  function open(next: View): void {
    // Assigning the fragment rather than pushState: it gives back/forward for free, and the
    // hashchange below is what actually moves the view, so both routes through this are one.
    location.hash = fragmentFor(next);
  }

  // Back, forward, a pasted link, or someone typing in the address bar.
  $effect(() => {
    const sync = () => (view = current());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  });

  const spawn = $derived(app.provenance?.spawn ?? null);
  const fetchedAt = $derived(app.provenance?.provenance?.fetchedAt ?? null);

  init();
</script>

<div class="mx-auto max-w-[1200px] bg-surface-main px-4 py-8 font-sans text-fg-primary sm:px-12">
  <header class="mb-8">
    <h1 class="text-[22px] font-semibold leading-tight">
      {app.model?.network.displayName ?? 'Product Preview Network'}
    </h1>
    <div class="mt-1.5 flex flex-wrap gap-4 text-[13px] text-fg-tertiary">
      {#if spawn || app.model}
        <span class="rounded-full bg-surface-nested px-2.5 py-0.5 text-xs font-medium text-fg-secondary">
          {spawn ? spawn.mode : app.model!.network.genesis ? 'genesis' : 'fork-only'}</span>
        {#if spawn?.bite}
          <span>bitten {new Date(spawn.bite.at).toLocaleString()} from {new URL(spawn.bite.source).host}</span>
        {/if}
      {/if}
      {#if spawn}
        <span>spawned {new Date(spawn.spawnedAt).toLocaleString()}</span>
        {#if spawn.ppnVersion}<span>ppn {spawn.ppnVersion}</span>{/if}
      {/if}
      {#if fetchedAt}<span>artifacts fetched {new Date(fetchedAt).toLocaleString()}</span>{/if}
    </div>
  </header>

  <nav class="mb-6 flex gap-1">
    {#each Object.keys(views) as name (name)}
      <button
        class="cursor-pointer rounded-t-lg border-b-2 px-3.5 py-2 text-sm font-medium transition-colors
               {view === name
                 ? 'border-fg-primary text-fg-primary'
                 : 'border-transparent text-fg-secondary hover:text-fg-primary'}"
        onclick={() => open(name as View)}>{name}</button>
    {/each}
  </nav>

  {#if app.error}
    <div class="p-8 text-center text-fg-tertiary">Cannot reach the dashboard API: {app.error}</div>
  {:else}
    <ViewComponent />
  {/if}
</div>
