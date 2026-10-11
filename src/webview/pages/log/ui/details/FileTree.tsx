import type { FileChange } from '@contracts/model';
import {
  FileTree as SharedFileTree,
  folderDecoration,
} from '@webview/shared/ui';

interface Props {
  files: readonly FileChange[];
  selectedPath: string | null;
  onOpen(this: void, fileId: string, preview: boolean): void;
}

function decoration(file: FileChange) {
  return {
    kind: file.status,
    badge: file.status[0]!.toUpperCase(),
    description: file.status[0]!.toUpperCase() + file.status.slice(1),
  };
}

export function FileTree({ files, selectedPath, onOpen }: Props) {
  return (
    <SharedFileTree
      files={files}
      label="Changed files"
      role="group"
      depth={1}
      selectedPath={selectedPath}
      pathOf={(file) => file.newPath ?? file.oldPath ?? 'File'}
      fileKey={(file) => file.id}
      decoration={decoration}
      folderDecoration={(files) => folderDecoration(files.map(decoration))}
      fileLabel={(file) =>
        `${file.status[0]!.toUpperCase() + file.status.slice(1)} · ${(file.newPath ?? file.oldPath)?.split('/').at(-1) ?? 'File'}`
      }
      fileTitle={(file) =>
        file.status === 'renamed'
          ? `${file.oldPath} → ${file.newPath}`
          : (file.newPath ?? file.oldPath ?? 'File')
      }
      onOpen={(file, preview) => onOpen(file.id, preview)}
    />
  );
}
