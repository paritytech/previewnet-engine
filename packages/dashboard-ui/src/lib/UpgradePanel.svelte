<script lang="ts">
  import { startUpgrade } from './api';

  let { chain }: { chain: string } = $props();
  let lines = $state<string[]>([]);
  let phase = $state<'idle' | 'running' | 'ok' | 'error'>('idle');
  let pathInput = $state('');
  let dragging = $state(false);

  async function start(wasm: File | { path: string }) {
    phase = 'running';
    lines = [];
    try {
      const events = await startUpgrade(chain, wasm);
      const source = new EventSource(events);
      source.onmessage = (e) => lines.push(e.data);
      source.addEventListener('done', (e) => {
        phase = (e as MessageEvent).data === 'ok' ? 'ok' : 'error';
        source.close();
      });
    } catch (err) {
      phase = 'error';
      lines.push((err as Error).message);
    }
  }

  function onFile(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (file) start(file);
  }
  function onDrop(ev: DragEvent) {
    ev.preventDefault();
    dragging = false;
    const file = ev.dataTransfer?.files?.[0];
    if (file) start(file);
  }
  function onPath(ev: Event) {
    ev.preventDefault();
    if (pathInput.trim()) start({ path: pathInput.trim() });
  }
</script>

<div class="mt-1 rounded-nested bg-surface-nested p-3">
  {#if phase === 'idle'}
    <div
      class="rounded-medium border border-dashed p-3 text-xs transition-colors
             {dragging ? 'border-fg-secondary text-fg-primary' : 'border-divider text-fg-secondary'}"
      role="region"
      ondragover={(e) => { e.preventDefault(); dragging = true; }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}>
      <div class="mb-2">
        Drop the runtime for <span class="font-medium text-fg-primary">{chain}</span> here, pick a file,
        or give a path on this machine (e.g. a runtime repo's
        <code class="font-mono">target/release/wbuild/…/*.compact.compressed.wasm</code>):
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input type="file" accept=".wasm" class="text-xs" onchange={onFile} />
        <form class="flex min-w-0 flex-1 gap-2" onsubmit={onPath}>
          <input
            type="text"
            bind:value={pathInput}
            placeholder="/path/to/runtime.compact.compressed.wasm"
            class="min-w-0 flex-1 rounded-medium bg-surface-container px-2.5 py-1.5 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary"
          />
          <button
            type="submit"
            class="cursor-pointer rounded-medium bg-surface-container px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:text-fg-primary"
            disabled={!pathInput.trim()}>upgrade</button>
        </form>
      </div>
    </div>
  {:else}
    <div class="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg-secondary">
      {#each lines as line}<div>{line}</div>{/each}
    </div>
    {#if phase === 'ok'}<div class="mt-1.5 text-xs font-medium text-status-ok">Upgrade applied.</div>
    {:else if phase === 'error'}<div class="mt-1.5 text-xs font-medium text-status-err">Upgrade failed — the log above says why.</div>{/if}
  {/if}
</div>
