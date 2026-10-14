import type {
  SourceControlBridge,
  SourceControlRepository,
  SourceControlState,
  WorkingFile,
} from '@contracts/source-control';
import { ActionButton, folderDecoration } from '@webview/shared/ui';

import { type ChangeSection, sectionDecoration } from '../model/change-groups';
import { folderKey } from '../model/view-state';
import { ChangeTree } from './ChangeTree';

export function CommitChangeGroup({
  repository,
  files,
  section,
  label,
  checked,
  collapsed,
  disabled,
  groupByDirectory,
  hoverDelay,
  reveal,
  bridge,
  onCollapse,
}: {
  repository: SourceControlRepository;
  files: readonly WorkingFile[];
  section: ChangeSection;
  label: string;
  checked: ReadonlySet<string>;
  collapsed: readonly string[];
  disabled: boolean;
  groupByDirectory: boolean;
  hoverDelay: number;
  reveal: SourceControlState['reveal'];
  bridge: SourceControlBridge;
  onCollapse(this: void, key: string, collapsed: boolean): void;
}) {
  const context = (path: string, selected: WorkingFile[], folder = false) =>
    JSON.stringify({
      webviewSection: 'working-change',
      preventDefaultContextMenuItems: true,
      repositoryId: repository.info.id,
      path,
      paths: selected.map((file) => file.path),
      copyPaths: folder && path ? [path] : selected.map((file) => file.path),
      staged: section === 'index',
      working: section === 'working',
      conflict: section === 'merge',
      changeOnlyConflicts: section === 'merge',
      changeCanMergeEditor: selected.every((file) =>
        ['UU', 'AA'].includes(file.status),
      ),
      changeCanStage: section !== 'index',
      changeCanUnstage: section === 'index',
      changeCanDelete: selected.some(
        (file) => sectionDecoration(file, section).kind !== 'deleted',
      ),
      changeCanReveal: Boolean(path),
      changeSelectionCount: selected.length,
      index: section === 'index',
    });

  return (
    <ChangeTree
      files={files}
      pathLabel={repository.pathLabel}
      hoverDelay={hoverDelay}
      label={label}
      root={label}
      snapshot={section}
      groupByDirectory={groupByDirectory}
      reveal={reveal}
      checked={checked}
      collapsed={collapsed}
      disabled={disabled}
      fileKey={(file) => file.path}
      folderKey={(path) => folderKey(repository.info.id, section, path)}
      onCollapse={onCollapse}
      onCheck={(items, included) => {
        if (!disabled)
          bridge.send({
            kind: 'check',
            repositoryId: repository.info.id,
            paths: items.map((file) => file.path),
            checked: included,
          });
      }}
      onOpen={(file) =>
        bridge.send({
          kind: 'open-working',
          repositoryId: repository.info.id,
          path: file.path,
          index: section === 'index',
        })
      }
      context={(file, selected) => context(file.path, selected)}
      folderContext={(path, selected) => context(path, selected, true)}
      actions={(file) => (
        <>
          <ActionButton
            label={section === 'index' ? 'Unstage Changes' : 'Stage Changes'}
            icon={section === 'index' ? 'remove' : 'add'}
            disabled={disabled}
            onClick={() =>
              bridge.send({
                kind: section === 'index' ? 'unstage-files' : 'stage-files',
                repositoryId: repository.info.id,
                paths: [file.path],
              })
            }
          />
          {section === 'working' && (
            <ActionButton
              label="Discard Changes"
              icon="discard"
              disabled={disabled}
              onClick={() =>
                bridge.send({
                  kind: 'discard-working',
                  repositoryId: repository.info.id,
                  path: file.path,
                })
              }
            />
          )}
        </>
      )}
      decoration={(file) => sectionDecoration(file, section)}
      folderDecoration={(items) =>
        folderDecoration(items.map((file) => sectionDecoration(file, section)))
      }
    />
  );
}
