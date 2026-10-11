export const blameSha = 'a'.repeat(40);

export function porcelainRecord(
  options: {
    sha?: string;
    originalLine?: number;
    line?: number;
    filename?: string;
    text?: string;
    extra?: string;
  } = {},
): string {
  return `${options.sha ?? blameSha} ${options.originalLine ?? 7} ${options.line ?? 1} 1
author First Author
author-mail <first@example.test>
author-time 1700000000
author-tz +0530
committer First Author
committer-mail <first@example.test>
committer-time 1700000000
committer-tz +0530
summary First change
${options.extra ?? ''}filename ${options.filename ?? 'old ü.txt'}
\t${options.text ?? 'first'}\n`;
}
