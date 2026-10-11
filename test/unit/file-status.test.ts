import { expect, test } from 'vitest';

import { fileDecoration } from '../../src/webview/pages/source-control/model/file-status';

test.each([
  [' M', 'M', 'Modified'],
  ['M ', 'M', 'Index Modified'],
  ['MM', 'M', 'Modified'],
  ['A ', 'A', 'Index Added'],
  [' A', 'A', 'Intent to Add'],
  ['AM', 'M', 'Modified'],
  [' D', 'D', 'Deleted'],
  ['D ', 'D', 'Index Deleted'],
  ['R ', 'R', 'Index Renamed'],
  [' R', 'R', 'Intent to Rename'],
  ['RM', 'M', 'Modified'],
  ['C ', 'C', 'Index Copied'],
  [' T', 'T', 'Type Changed'],
  ['??', 'U', 'Untracked'],
  ['DD', '!', 'Conflict: Both Deleted'],
  ['AU', '!', 'Conflict: Added By Us'],
  ['UD', '!', 'Conflict: Deleted By Them'],
  ['UA', '!', 'Conflict: Added By Them'],
  ['DU', '!', 'Conflict: Deleted By Us'],
  ['AA', '!', 'Conflict: Both Added'],
  ['UU', '!', 'Conflict: Both Modified'],
  ['M', 'M', 'Modified'],
  ['A', 'A', 'Added'],
  ['R100', 'R', 'Renamed'],
])(
  'Git status %s uses the native badge and hover description',
  (status, badge, description) => {
    expect(fileDecoration(status)).toMatchObject({ badge, description });
  },
);
