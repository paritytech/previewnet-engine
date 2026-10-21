<script lang="ts">
  import { renderSVG } from 'uqr';
  import { fetchStack } from './api';
  import type { Stack } from './api';

  let stack = $state<Stack | null>(null);
  let copied = $state<string | null>(null);
  fetchStack().then((s) => (stack = s)).catch(() => (stack = null));

  const qr = $derived(stack ? renderSVG(stack.link) : '');

  const rows = $derived<[string, string][]>(
    stack
      ? [
          ['Link', stack.link],
          ['Descriptor', stack.pointer.url],
          ...(stack.pointer.key ? [['Key', stack.pointer.key] as [string, string]] : []),
        ]
      : []
  );

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    copied = text;
    setTimeout(() => (copied = null), 1200);
  }
</script>

{#if stack}
  <h2 class="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-wide text-fg-tertiary">Trinity stack</h2>
  <div class="flex flex-col gap-4 overflow-hidden rounded-container bg-surface-container p-4 shadow-1 sm:flex-row">
    <!-- renderSVG's output is an SVG string built from the link alone, never page input. -->
    <div class="w-40 shrink-0 self-center" aria-label="QR code of the stack link">{@html qr}</div>
    <div class="min-w-0 flex-1">
      {#each rows as [label, value] (label)}
        <div class="flex items-center gap-3 border-b border-divider py-2.5 last:border-0">
          <span class="w-24 shrink-0 text-sm font-medium text-fg-primary">{label}</span>
          <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary" title={value}>{value}</code>
          <button
            class="shrink-0 cursor-pointer text-xs text-fg-tertiary transition-colors hover:text-fg-primary"
            onclick={() => copy(value)}>{copied === value ? 'copied' : 'copy'}</button>
        </div>
      {/each}
      <p class="pt-2.5 text-xs text-fg-tertiary">
        {stack.pointer.key ? 'Signed' : 'Unsigned'}, sequence {stack.state.sequence}. Scan the code or open the link
        in a host to add this stack.
      </p>
    </div>
  </div>
{/if}
