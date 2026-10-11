import { workspace } from 'vscode';

import type { BlameTextCodec } from '../git/blame-model';

export const nativeBlameCodec: BlameTextCodec = {
  encode: async (text, encoding) => workspace.encode(text, { encoding }),
  decode: async (bytes, encoding) => workspace.decode(bytes, { encoding }),
};
