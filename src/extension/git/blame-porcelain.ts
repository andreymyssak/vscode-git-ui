import type { BlameLine } from './blame-model';

const invalid = () => new Error('Invalid Git blame output.');

function filename(value: string): string {
  if (!value.startsWith('"')) {
    if (!value || value.includes('\0')) throw invalid();

    return value;
  }

  if (!value.endsWith('"')) throw invalid();
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };

  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];

    if (char === undefined) throw invalid();
    if (char !== '\\') {
      const point = value.codePointAt(index);

      if (point === undefined || char === '"') throw invalid();
      bytes.push(...Buffer.from(String.fromCodePoint(point), 'utf8'));
      if (point > 0xffff) index++;
      continue;
    }

    const next = value[++index];

    if (next === undefined || index >= value.length - 1) throw invalid();
    if (/[0-7]/.test(next)) {
      const octal = value.slice(index, index + 3);

      if (!/^[0-7]{3}$/.test(octal)) throw invalid();
      const byte = Number.parseInt(octal, 8);

      if (byte > 255) throw invalid();
      bytes.push(byte);
      index += 2;
    } else {
      const byte = escapes[next];

      if (byte === undefined) throw invalid();
      bytes.push(byte);
    }
  }

  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(bytes),
  );

  if (!decoded || decoded.includes('\0')) throw invalid();

  return decoded;
}

function required(metadata: Map<string, string>, key: string): string {
  const value = metadata.get(key);

  if (value === undefined) throw invalid();

  return value;
}

export function parseBlamePorcelain(output: string): readonly BlameLine[] {
  if (!output) return [];
  const records = output.split('\n');

  if (records.at(-1) === '') records.pop();
  const result: BlameLine[] = [];
  let index = 0;

  while (index < records.length) {
    const header =
      /^(?<sha>[a-f0-9]{40}|[a-f0-9]{64}) (?<original>[1-9]\d*) (?<line>[1-9]\d*)(?: [1-9]\d*)?$/.exec(
        records[index++] ?? '',
      );
    const sha = header?.groups?.sha;
    const originalLine = Number(header?.groups?.original);
    const line = Number(header?.groups?.line);

    if (
      !sha ||
      !Number.isSafeInteger(originalLine) ||
      line !== result.length + 1
    )
      throw invalid();
    const metadata = new Map<string, string>();
    let text: string | undefined;

    while (index < records.length) {
      const entry = records[index++];

      if (entry === undefined) throw invalid();
      if (entry.startsWith('\t')) {
        text = entry.slice(1);
        break;
      }

      const separator = entry.indexOf(' ');

      if (separator < 0) continue;
      const key = entry.slice(0, separator);

      if (metadata.has(key)) throw invalid();
      metadata.set(key, entry.slice(separator + 1));
    }

    if (text === undefined) throw invalid();
    const originalPath = filename(required(metadata, 'filename'));

    if (/^0+$/.test(sha)) {
      result.push({ kind: 'uncommitted', line, text });
      continue;
    }

    const timestamp = required(metadata, 'author-time');

    if (!/^-?\d+$/.test(timestamp)) throw invalid();
    const date = new Date(Number(timestamp) * 1000);

    if (!Number.isFinite(date.getTime())) throw invalid();
    const mail = /^<(.*)>$/.exec(required(metadata, 'author-mail'));

    if (mail?.[1] === undefined) throw invalid();
    result.push({
      kind: 'committed',
      line,
      text,
      originalLine,
      originalPath,
      sha,
      authorName: required(metadata, 'author'),
      authorEmail: mail[1],
      authorDate: date.toISOString(),
      summary: required(metadata, 'summary'),
    });
  }

  return result;
}
