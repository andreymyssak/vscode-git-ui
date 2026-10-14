import { useState } from 'react';

/** Highlighting targets context actions; inclusion checkboxes remain independent. */
export function useRowSelection(
  order: readonly string[],
  external: string | null = null,
) {
  const [previousExternal, setPreviousExternal] = useState(external);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(external ? [external] : []),
  );
  const [anchor, setAnchor] = useState<string | null>(external);

  if (previousExternal !== external) {
    setPreviousExternal(external);
    setSelected(new Set(external ? [external] : []));
    setAnchor(external);
  }

  const select = (
    path: string,
    modifiers: {
      shiftKey?: boolean;
      metaKey?: boolean;
      ctrlKey?: boolean;
    } = {},
  ) => {
    const additive = modifiers.metaKey || modifiers.ctrlKey;
    let next: Set<string>;
    const start = anchor === null ? -1 : order.indexOf(anchor);
    const end = order.indexOf(path);

    if (modifiers.shiftKey && start >= 0 && end >= 0) {
      next = new Set(additive ? selected : []);
      for (const key of order.slice(
        Math.min(start, end),
        Math.max(start, end) + 1,
      ))
        next.add(key);
    } else {
      next = new Set(additive ? selected : []);
      if (additive && next.has(path)) next.delete(path);
      else next.add(path);
      setAnchor(path);
    }

    setSelected(next);

    return next;
  };

  return { selected, select };
}
