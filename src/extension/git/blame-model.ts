export type BlameSource =
  | { kind: 'revision'; path: string; sha: string }
  | { kind: 'contents'; path: string; headSha: string; contents: string };

export interface BlameQuery {
  repositoryId: string;
  source: BlameSource;
  ignoreWhitespace: boolean;
}

export type BlameLine =
  | { kind: 'uncommitted'; line: number; text: string }
  | {
      kind: 'committed';
      line: number;
      text: string;
      originalLine: number;
      originalPath: string;
      sha: string;
      authorName: string;
      authorEmail: string;
      authorDate: string;
      summary: string;
    };

export type BlameResult =
  { kind: 'blame'; lines: readonly BlameLine[] } | { kind: 'no-history' };
