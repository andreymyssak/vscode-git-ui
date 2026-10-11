import type { BlameTextCodec } from './blame-model';

function requireUtf8(encoding: string): void {
  if (!['utf8', 'utf8bom', 'utf-8'].includes(encoding))
    throw new Error('This encoding requires the native editor text codec.');
}

export const utf8BlameCodec: BlameTextCodec = {
  encode: (text, encoding) =>
    Promise.resolve().then(() => {
      requireUtf8(encoding);

      return Buffer.from((encoding === 'utf8bom' ? '\uFEFF' : '') + text);
    }),
  decode: (bytes, encoding) =>
    Promise.resolve().then(() => {
      requireUtf8(encoding);

      return new TextDecoder('utf-8').decode(bytes);
    }),
};

export async function decodeBlamePorcelain(
  output: Buffer,
  codec: BlameTextCodec,
  encoding: string,
): Promise<string> {
  if (!output.length) return '';
  const records: Buffer[] = [];
  const source: Buffer[] = [];
  const newline = Buffer.from('\n');

  for (let start = 0; start < output.length;) {
    const end = output.indexOf(10, start);
    const record = output.subarray(start, end < 0 ? output.length : end);

    records.push(record);
    if (record[0] === 9) source.push(record.subarray(1), newline);
    start = end < 0 ? output.length : end + 1;
  }

  // Metadata is UTF-8, while source records contain the repository's bytes.
  // Decode the complete source once, as required by native encoding APIs.
  const text = (await codec.decode(Buffer.concat(source), encoding)).split(
    '\n',
  );

  if (text.pop() !== '' || text.length !== source.length / 2)
    throw new Error('Git cannot annotate this file encoding as text.');
  let line = 0;

  return (
    records
      .map((record) => {
        if (record[0] !== 9) return record.toString('utf8');
        const content = text[line++];

        if (content === undefined) throw new Error('Invalid Git blame output.');

        return '\t' + content;
      })
      .join('\n') + '\n'
  );
}
