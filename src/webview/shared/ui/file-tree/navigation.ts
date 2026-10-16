import type { KeyboardEvent } from 'react';

export function navigateFileTree(
  event: KeyboardEvent<HTMLDivElement>,
  tree: HTMLElement = event.currentTarget,
  focus: (row: HTMLElement) => void = (row) => row.focus(),
) {
  if (
    event.defaultPrevented ||
    ![
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
    ].includes(event.key) ||
    !(event.target instanceof HTMLElement)
  )
    return;
  const target = event.target.closest<HTMLElement>('[role="treeitem"]');
  const rows = [
    ...tree.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].filter((row) => {
    if (row.closest('[hidden]')) return false;
    let parent = row.parentElement;

    while (parent && parent !== tree) {
      if (
        parent instanceof HTMLDetailsElement &&
        !parent.open &&
        parent.querySelector(':scope > summary') !== row
      )
        return false;
      parent = parent.parentElement;
    }

    return true;
  });
  const index = target ? rows.indexOf(target) : -1;

  if (!target || index < 0) return;
  event.preventDefault();
  const folder = target.closest('details');
  const ownsFolder = folder?.querySelector(':scope > summary') === target;

  if (event.key === 'ArrowRight') {
    if (ownsFolder && folder) {
      if (!folder.open)
        (
          target.querySelector<HTMLElement>('[data-tree-disclosure]') ?? target
        ).click();
      else {
        const next = rows[index + 1];

        if (next) focus(next);

        return next;
      }
    }

    return;
  }

  if (event.key === 'ArrowLeft') {
    if (ownsFolder && folder?.open)
      (
        target.querySelector<HTMLElement>('[data-tree-disclosure]') ?? target
      ).click();
    else {
      const parent = ownsFolder
        ? folder?.parentElement?.closest('details')
        : folder;

      const next = parent?.querySelector<HTMLElement>(
        ':scope > [role="treeitem"]',
      );

      if (next) focus(next);

      return next;
    }

    return;
  }

  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index - 1);

  const row = rows[next];

  if (row) focus(row);

  return row;
}
