import { expect, test } from 'vitest';

import {
  historyCommit,
  historyFields,
} from '../../src/extension/git/history-records';

const valid = [
  'a'.repeat(40),
  'b'.repeat(40),
  'Zoë [dev]',
  'zoe@example.test',
  '1700000000',
  '1791457200',
  '\n漢字 message\n\n  indented\n',
];

test('history framing keeps split UTF-8 characters and exact multiline message fields', () => {
  const records: string[][] = [];
  const parser = historyFields(7, (fields) => {
    records.push(fields);

    return true;
  });

  for (const byte of Buffer.from(valid.join('\0') + '\0'))
    parser.write(Buffer.from([byte]));
  parser.finish();
  expect(records).toEqual([valid]);
  expect(historyCommit(records[0]!).message).toBe(
    '\n漢字 message\n\n  indented\n',
  );
});

test.each([
  ['invalid hash', 0, '--all'],
  ['invalid parent', 1, 'no-parent'],
  ['invalid date', 4, 'not-a-date'],
])('history metadata rejects %s', (_name, index, value) => {
  const fields = [...valid];

  fields[Number(index)] = String(value);
  expect(() => historyCommit(fields)).toThrow(/invalid/i);
});

test('history framing rejects missing or NUL-displaced metadata fields', () => {
  const parser = historyFields(7, historyCommitAndContinue);

  parser.write(Buffer.from(valid.slice(0, 6).join('\0') + '\0'));
  expect(() => parser.finish()).toThrow('incomplete');
  const displaced = historyFields(7, historyCommitAndContinue);

  expect(() => {
    displaced.write(
      Buffer.from(valid.join('\0').replace('Zoë', 'Zo\0ë') + '\0'),
    );
    displaced.finish();
  }).toThrow(/invalid|incomplete/i);
});

function historyCommitAndContinue(fields: string[]) {
  historyCommit(fields);

  return true;
}
