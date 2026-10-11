import type { BlameLine } from '../git/blame-model';

export function matchesBlameText(
  lines: readonly BlameLine[],
  text: string,
): boolean {
  if (!text) return lines.length === 0;
  const displayed = text.replace(/\r\n/g, '\n').split('\n');

  if (displayed.at(-1) === '') displayed.pop();

  return (
    lines.length === displayed.length &&
    lines.every(
      (line, index) =>
        line.line === index + 1 &&
        line.text.replace(/\r$/, '') === displayed[index],
    )
  );
}
