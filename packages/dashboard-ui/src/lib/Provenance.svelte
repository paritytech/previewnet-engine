<script lang="ts">
  import { app } from './store.svelte';
  import type { ProvenanceArtifact } from './api';

  const stamp = $derived(app.provenance?.provenance ?? null);

  // Toolchain is absent from stamps written before it was recorded — an older release's
  // bin/provenance.json is still valid, it just has one fewer group. Empty groups are dropped
  // rather than rendered as an empty table.
  const groups = $derived<[string, ProvenanceArtifact[]][]>(
    stamp
      ? ([
          ['Node binaries', stamp.binaries ?? []],
          ['Runtimes', stamp.runtimes ?? []],
          ['Toolchain', stamp.toolchain ?? []],
        ] as [string, ProvenanceArtifact[]][]).filter(([, rows]) => rows.length > 0)
      : []
  );
</script>

{#if !stamp}
  <div class="p-8 text-center text-fg-tertiary">
    No provenance stamp — run `ppn fetch` from a version that writes one.
  </div>
{:else}
  {#each groups as [title, rows] (title)}
    <h2 class="mb-3 mt-7 text-[15px] font-semibold leading-tight text-fg-secondary">{title}</h2>
    <div class="overflow-x-auto rounded-container bg-surface-container shadow-1">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {#each ['name', 'source', 'pinned', 'resolved', 'version', 'sha256'] as h}
              <th class="px-3 py-1.5 text-left font-medium text-fg-tertiary">{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as a (a.name)}
            <tr class="odd:bg-surface-nested">
              <td class="px-3 py-1.5 text-fg-secondary">{a.name}</td>
              <td class="px-3 py-1.5 text-fg-secondary">{a.repo}</td>
              <td class="px-3 py-1.5"><code class="font-mono text-xs text-fg-secondary">{a.pinned}</code></td>
              <td class="px-3 py-1.5">
                <!-- A pin that moved is the interesting cell: `latest` is what the descriptor
                     says, the tag beside it is what this network actually got. -->
                <code class="font-mono text-xs {a.pinned !== a.resolved ? 'font-medium text-fg-primary' : 'text-fg-secondary'}">{a.resolved}</code>
              </td>
              <!-- Runtimes are WASM and answer no --version; so does anything whose
                   --version exits non-zero. Both land as an em dash. -->
              <td class="px-3 py-1.5 font-mono text-xs text-fg-secondary">{a.version ?? '—'}</td>
              <td class="px-3 py-1.5 font-mono text-xs text-fg-tertiary" title={a.sha256}>
                {a.sha256.slice(0, 16)}…
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/each}
{/if}
