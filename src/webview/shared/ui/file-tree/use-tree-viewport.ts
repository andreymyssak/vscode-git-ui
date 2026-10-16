import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

/** Use the pane's existing scroller, including trees nested inside stash cards. */
export function useTreeViewport(
  tree: RefObject<HTMLDivElement | null>,
  keys: readonly string[],
  active: string | undefined,
) {
  const [layout, setLayout] = useState<{
    owner: HTMLElement | null;
    margin: number;
    measured: boolean;
  }>({ owner: null, margin: 0, measured: false });
  const pending = useRef<string | null>(null);
  const activeIndex = active === undefined ? -1 : keys.indexOf(active);
  // TanStack owns mutable measurements; this hook intentionally stays outside compiler memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: keys.length,
    getScrollElement: () => layout.owner,
    estimateSize: () => 22,
    getItemKey: (index) => keys[index] ?? index,
    overscan: 6,
    scrollMargin: layout.margin,
    initialRect: { width: 0, height: 660 },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);

      // Boundary rows let the enclosing comparison tree enter a virtual group
      // with its normal DOM keyboard navigation, without mounting the middle.
      for (const index of [0, keys.length - 1, activeIndex])
        if (index >= 0 && index < keys.length && !indexes.includes(index))
          indexes.push(index);

      return indexes.sort((a, b) => a - b);
    },
  });

  useLayoutEffect(() => {
    const element = tree.current;

    if (!element) return;
    let owner = element.parentElement;

    while (owner && !/(auto|scroll)/.test(getComputedStyle(owner).overflowY))
      owner = owner.parentElement;
    const measure = () => {
      const margin = owner
        ? element.getBoundingClientRect().top -
          owner.getBoundingClientRect().top +
          owner.scrollTop -
          owner.clientTop
        : 0;

      setLayout((previous) =>
        previous.owner === owner &&
        previous.margin === margin &&
        previous.measured
          ? previous
          : { owner, margin, measured: true },
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    let ancestor: HTMLElement | null = element;

    while (ancestor) {
      observer.observe(ancestor);
      if (ancestor === owner) break;
      // Earlier comparison groups and stash sections can move this tree while
      // its own size and the fixed-height scroll owner stay unchanged.
      let preceding = ancestor.previousElementSibling;

      while (preceding) {
        observer.observe(preceding);
        preceding = preceding.previousElementSibling;
      }

      ancestor = ancestor.parentElement;
    }

    return () => observer.disconnect();
  });

  useLayoutEffect(() => {
    if (pending.current === null) return;
    const row = [
      ...(tree.current?.querySelectorAll<HTMLElement>('[data-tree-row-key]') ??
        []),
    ].find((element) => element.dataset.treeRowKey === pending.current);

    if (row) {
      pending.current = null;
      row.focus({ preventScroll: true });
    }
  });

  const reveal = (index: number, focus: boolean) => {
    if (focus) pending.current = keys[index] ?? null;
    const end = layout.margin + (index + 1) * 22;

    if (
      layout.owner &&
      index === keys.length - 1 &&
      end >= layout.owner.scrollTop + layout.owner.clientHeight
    ) {
      // TanStack aligns its final item to the owner's absolute end. Our owner
      // may contain later trees, so align this indexed row's own end instead.
      virtualizer.scrollToOffset(end, { align: 'end' });
    } else virtualizer.scrollToIndex(index, { align: 'auto' });
    const row = [
      ...(tree.current?.querySelectorAll<HTMLElement>('[data-tree-row-key]') ??
        []),
    ].find((element) => element.dataset.treeRowKey === keys[index]);

    if (focus && row) {
      pending.current = null;
      row.focus({ preventScroll: true });
    }
  };

  // Isolated trees without a scroll owner (including jsdom) use natural layout.
  // Real panes always supply an owner, even while hidden or temporarily zero-sized.
  const natural = layout.measured && layout.owner === null;
  const items = natural
    ? keys.map((key, index) => ({ key, index, start: index * 22 }))
    : virtualizer.getVirtualItems();

  return {
    items,
    reveal,
    natural,
    ready: layout.measured,
    margin: layout.margin,
    height: keys.length * 22,
  };
}
