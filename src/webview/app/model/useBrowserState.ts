import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { normalizeHistoryFilters } from '@contracts/history-filters';
import { readHistoryPresentation } from '@contracts/history-presentation';
import type { RequestBody } from '@contracts/messages';
import type { LogIntent } from '@webview/pages/log';
import type { BrowserBridge } from '@webview/shared/api';

import { readSaved, restoreView } from './persistence';
import type { ViewEvent, ViewState } from './state';
import { initialView, reduceView } from './state';

export interface BrowserController {
  state: ViewState;
  request(this: void, body: RequestBody): void;
  onLogIntent(this: void, intent: LogIntent): void;
  setActiveView(this: void, view: 'log' | 'worktrees'): void;
}
export function useBrowserState(bridge: BrowserBridge): BrowserController {
  const [saved] = useState(() => readSaved(bridge.getState()));
  const [store] = useState(() =>
    createStore<ViewState>()(() => ({
      ...initialView(),
      activeView: saved.activeView,
      paneWidths: saved.paneWidths,
      branchesCollapsed: saved.branchesCollapsed ?? false,
      historyColumnWidths: saved.historyColumnWidths ?? null,
      filters: normalizeHistoryFilters(saved.filters),
      showHash: saved.showHash ?? false,
      presentation: readHistoryPresentation(saved.presentation),
      hashColumnWidth: saved.hashColumnWidth ?? 100,
    })),
  );
  const state = useStore(store);
  const restorePending = useRef(saved.repositoryId !== null);
  const restoreStarted = useRef(false);
  const worktreesPending = useRef(saved.activeView === 'worktrees');
  const restoreAttempt = useRef<{
    requestId: string;
    generation: number;
  } | null>(null);
  const update = useCallback(
    (event: ViewEvent) => {
      const next = reduceView(store.getState(), event);

      store.setState(next, true);

      return next;
    },
    [store],
  );
  const request = useCallback(
    (body: RequestBody) => {
      if (
        ['choose-repository', 'go-to', 'refresh', 'action'].includes(
          body.kind,
        ) ||
        (body.kind === 'history' && body.cursor === null)
      )
        restorePending.current = false;
      if (body.kind === 'open-file') {
        for (const [parent, files] of Object.entries(store.getState().files)) {
          const file = files.find((file) => file.id === body.fileId);

          if (file) {
            update({
              kind: 'update',
              patch: {
                selectedParentSha: parent === 'root' ? null : parent,
                selectedFilePath: file.newPath ?? file.oldPath,
              },
            });
            break;
          }
        }
      }

      if (
        body.kind === 'load-parent' &&
        body.sha === store.getState().selectedSha
      )
        update({
          kind: 'update',
          patch: {
            fileErrors: {
              ...store.getState().fileErrors,
              [body.parentSha ?? 'root']: undefined,
            },
          },
        });

      const snapshot = store.getState();

      return bridge.send(body, {
        repositoryId: snapshot.repository?.id ?? '',
        generation: snapshot.generation,
      });
    },
    [bridge, store, update],
  );
  const onLogIntent = useCallback(
    (intent: LogIntent) => {
      if (
        [
          'select-ref',
          'select-commit',
          'apply-scope',
          'search',
          'filters',
        ].includes(intent.kind)
      )
        restorePending.current = false;
      switch (intent.kind) {
        case 'select-ref':
          update(intent);
          break;
        case 'apply-scope': {
          update({
            kind: 'select-ref',
            refId: intent.scope.kind === 'ref' ? intent.scope.refId : null,
          });
          const next = update(intent);

          request({
            kind: 'history',
            scope: next.scope,
            text: next.text,
            filters: next.filters,
            cursor: null,
          });
          break;
        }

        case 'search': {
          update({ kind: 'update', patch: { text: intent.text } });
          const next = update({
            kind: 'apply-scope',
            scope: store.getState().scope,
          });

          request({
            kind: 'history',
            scope: next.scope,
            text: next.text,
            filters: next.filters,
            cursor: null,
          });
          break;
        }

        case 'filters': {
          update({ kind: 'update', patch: { filters: intent.filters } });
          const next = update({
            kind: 'apply-scope',
            scope: store.getState().scope,
          });

          request({
            kind: 'history',
            scope: next.scope,
            text: next.text,
            filters: next.filters,
            cursor: null,
          });
          break;
        }

        case 'show-hash':
          update({ kind: 'update', patch: { showHash: intent.show } });
          break;
        case 'presentation':
          update({
            kind: 'update',
            patch: { presentation: intent.presentation },
          });
          break;
        case 'hash-column':
          update({
            kind: 'update',
            patch: {
              hashColumnWidth: intent.width,
              ...(intent.metadata
                ? { historyColumnWidths: intent.metadata }
                : {}),
            },
          });
          break;
        case 'select-commit': {
          const before = store.getState();
          const next = update({
            kind: 'select-commit',
            sha: intent.sha,
            ...(intent.gesture ? { gesture: intent.gesture } : {}),
          });

          if (next === before) break;
          update({
            kind: 'update',
            patch: {
              scrollTop: intent.scrollTop ?? store.getState().scrollTop,
            },
          });
          const changedRange =
            next.selectedSha !== before.selectedSha ||
            next.commitRange.selectedShas.length !==
              before.commitRange.selectedShas.length ||
            next.commitRange.selectedShas.some(
              (sha, index) => sha !== before.commitRange.selectedShas[index],
            );
          const comparison = before.details?.parents[0] ?? 'root';

          if (
            changedRange ||
            !before.details ||
            !Object.hasOwn(before.files, comparison)
          )
            request({
              kind: 'select-commits',
              shas: [...next.commitRange.selectedShas],
              activeSha: intent.sha,
            });
          break;
        }

        case 'scroll':
          // Empty and partial restoring pages can clamp the DOM viewport.
          // Keep the user's anchor until the host finishes restoring it.
          if (store.getState().restoring) break;
          update({
            kind: 'update',
            patch: { scrollTop: intent.scrollTop, anchor: intent.anchor },
          });
          request({ kind: 'anchor', anchor: intent.anchor });
          break;
        case 'pane-widths':
          update({ kind: 'update', patch: { paneWidths: intent.widths } });
          break;
        case 'branches-collapsed':
          update({
            kind: 'update',
            patch: { branchesCollapsed: intent.collapsed },
          });
          break;
        case 'history-columns':
          update({
            kind: 'update',
            patch: { historyColumnWidths: intent.widths },
          });
          break;
        case 'request':
          if (intent.body.kind === 'history')
            update({ kind: 'update', patch: { loading: true } });
          request(intent.body);
          break;
        default: {
          const exhaustive: never = intent;

          void exhaustive;
        }
      }
    },
    [request, store, update],
  );
  const setActiveView = useCallback(
    (view: 'log' | 'worktrees') => {
      restorePending.current = false;
      const next = update({ kind: 'view', view });

      worktreesPending.current = view === 'worktrees' && !next.repository;
      if (view === 'worktrees' && next.repository)
        request({ kind: 'worktrees' });
    },
    [request, update],
  );

  useEffect(() => {
    const stop = bridge.subscribe((message) => {
      const before = store.getState();

      if (
        message.body.kind === 'focus-log' &&
        message.generation >= before.generation &&
        (!before.repository || message.repositoryId === before.repository.id)
      ) {
        restorePending.current = false;
        worktreesPending.current = false;
      }

      const ownsCompletion =
        restorePending.current &&
        message.requestId === restoreAttempt.current?.requestId &&
        // A failed ref read can advance the host before publishing loading.
        message.generation >= before.generation &&
        message.repositoryId === before.repository?.id &&
        ['selection', 'error'].includes(message.body.kind);
      const next = update(
        ownsCompletion && message.body.kind === 'error'
          ? {
              kind: 'restore-error',
              repositoryId: message.repositoryId,
              generation: message.generation,
              message: message.body.message,
            }
          : { kind: 'host', message },
      );

      if (
        message.body.kind === 'filters' &&
        message.generation === next.generation &&
        message.repositoryId === next.repository?.id
      )
        onLogIntent({ kind: 'filters', filters: message.body.filters });
      if (
        restorePending.current &&
        message.body.kind === 'history' &&
        message.generation === next.generation &&
        message.repositoryId === next.repository?.id &&
        (!restoreAttempt.current ||
          (message.generation > restoreAttempt.current.generation &&
            message.requestId !== restoreAttempt.current.requestId))
      ) {
        const restored = restoreView(saved, next.repositories);

        if (!restoreStarted.current) {
          restoreStarted.current = true;
          update({
            kind: 'update',
            patch: {
              activeView: restored.activeView,
              paneWidths: restored.paneWidths,
              branchesCollapsed: restored.branchesCollapsed ?? false,
              historyColumnWidths: restored.historyColumnWidths ?? null,
              showHash: restored.showHash ?? false,
              presentation: readHistoryPresentation(restored.presentation),
              hashColumnWidth: restored.hashColumnWidth ?? 100,
            },
          });
        }

        if (restored.repositoryId === next.repository?.id) {
          update({
            kind: 'update',
            patch: {
              selectedRefId:
                restored.selectedRefId === null && restored.scope.kind === 'all'
                  ? null
                  : next.refs.some((ref) => ref.id === restored.selectedRefId)
                    ? restored.selectedRefId
                    : next.selectedRefId,
              anchor: restored.anchor,
            },
          });
          const requestId = request({
            kind: 'restore',
            scope: restored.scope,
            text: restored.text,
            filters: normalizeHistoryFilters(restored.filters),
            selection: restored.selection,
            anchor: restored.anchor,
          });

          restoreAttempt.current = { requestId, generation: next.generation };
          if (restored.activeView === 'worktrees')
            worktreesPending.current = true;
        } else restorePending.current = false;
      }

      if (ownsCompletion) restorePending.current = false;
      const current = store.getState();

      if (
        worktreesPending.current &&
        (!restorePending.current ||
          (message.body.kind === 'error' && !restoreAttempt.current)) &&
        current.activeView === 'worktrees' &&
        message.repositoryId === current.repository?.id &&
        message.generation === current.generation
      ) {
        worktreesPending.current = false;
        request({ kind: 'worktrees' });
      }

      if (
        message.body.kind === 'reveal' &&
        next.selectedSha === message.body.sha
      ) {
        const index = next.commits.findIndex(
          (commit) => commit.sha === next.selectedSha,
        );

        if (index >= 0)
          update({ kind: 'update', patch: { scrollTop: index * 22 } });
      }
    });

    bridge.ready(saved.repositoryId);

    return stop;
  }, [bridge, saved, request, update, onLogIntent, store]);
  useEffect(() => {
    const snapshot = store.getState();

    if (restorePending.current || !snapshot.repository) return;
    bridge.setState({
      repositoryId: snapshot.repository.id,
      activeView: snapshot.activeView,
      scope: snapshot.scope,
      text: snapshot.text,
      filters: snapshot.filters,
      selectedRefId: snapshot.selectedRefId,
      selection: snapshot.selectedSha
        ? {
            sha: snapshot.selectedSha,
            parentSha:
              snapshot.selectedParentSha ??
              snapshot.details?.parents[0] ??
              null,
            filePath: snapshot.selectedFilePath,
          }
        : null,
      anchor: snapshot.anchor,
      paneWidths: snapshot.paneWidths,
      branchesCollapsed: snapshot.branchesCollapsed,
      historyColumnWidths: snapshot.historyColumnWidths,
      showHash: snapshot.showHash,
      presentation: snapshot.presentation,
      hashColumnWidth: snapshot.hashColumnWidth,
    });
  }, [bridge, store, state]);

  return { state, request, onLogIntent, setActiveView };
}
