import type {
  SourceControlBridge,
  SourceControlRequest,
  SourceControlResponse,
} from '@contracts/source-control';
import { parseSourceControlResponse } from '@contracts/source-control-protocol';

export interface SourceControlWebviewApi {
  postMessage(message: SourceControlRequest): void;
  getState(): unknown;
  setState(value: unknown): void;
}

export function createSourceControlBridge(
  api: SourceControlWebviewApi,
  target: EventTarget,
): SourceControlBridge {
  const listeners = new Set<(response: SourceControlResponse) => void>();
  let disposed = false;
  const ensureActive = () => {
    if (disposed) throw new Error('The source-control bridge is disposed.');
  };

  const receive = (event: Event) => {
    if (!(event instanceof MessageEvent)) return;
    const data: unknown = event.data;
    const response = parseSourceControlResponse(data);

    if (response) for (const listener of listeners) listener(response);
  };

  target.addEventListener('message', receive);

  return {
    send(request) {
      ensureActive();
      api.postMessage(request);
    },
    subscribe(listener) {
      ensureActive();
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => api.getState(),
    setState: (value) => api.setState(value),
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('message', receive);
      listeners.clear();
    },
  };
}
