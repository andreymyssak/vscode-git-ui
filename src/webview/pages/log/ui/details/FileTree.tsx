import type { FileChange } from '@contracts/model';
import {
  FileTree as SharedFileTree,
  folderDecoration,
} from '@webview/shared/ui';

interface Props {
  files: readonly FileChange[];
  selectedPath: string | null;
  onOpen(this: void, fileId: string, preview: boolean): void;
  context: {
    repositoryId: string;
    generation: number;
    commitSha: string;
    canApply: boolean;
  };
}

function decoration(file: FileChange) {
  return {
    kind: file.status,
    badge: file.status[0]!.toUpperCase(),
    description: file.status[0]!.toUpperCase() + file.status.slice(1),
  };
}

export function FileTree({ files, selectedPath, onOpen, context }: Props) {
  const payload = (selected: FileChange[]) => ({
    preventDefaultContextMenuItems: true,
    repositoryId: context.repositoryId,
    generation: context.generation,
    commitSha: context.commitSha,
    fileIds: selected.map((file) => file.id),
    fileSelectionCount: selected.length,
    fileCanApplyChanges:
      context.canApply && selected.length > 0 && selected.length <= 400,
  });

  return (
    <SharedFileTree
      files={files}
      label="Changed files"
      role="group"
      multiSelect
      context={(file, selected) =>
        JSON.stringify({
          ...payload(selected),
          webviewSection: 'commit-file',
          fileId: file.id,
        })
      }
      folderContext={(_path, selected) =>
        JSON.stringify({
          ...payload(selected),
          webviewSection: 'commit-folder',
        })
      }
      depth={1}
      selectedPath={selectedPath}
      revealSelected
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
