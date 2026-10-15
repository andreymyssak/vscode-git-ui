import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { BrowserBridge } from '@webview/shared/api';

import type { BrowserSession } from './browser-session';
import { createBrowserSession } from './browser-session';
import type { ViewState } from './state';

export type BrowserController<State = ViewState> = BrowserSession & {
  state: State;
};

export function useBrowserState(bridge: BrowserBridge): BrowserController;
export function useBrowserState<State>(
  bridge: BrowserBridge,
  selector: (state: ViewState) => State,
): BrowserController<State>;
export function useBrowserState(
  bridge: BrowserBridge,
  selector: (state: ViewState) => unknown = (state) => state,
): BrowserController<unknown> {
  const [session] = useState(() => createBrowserSession(bridge));

  useEffect(() => session.mount(), [session]);
  const state = useBrowserSelector(session.store, selector);

  return { ...session, state };
}

export function useBrowserSelector<State>(
  store: BrowserSession['store'],
  selector: (state: ViewState) => State,
): State {
  return useStore(store, useShallow(selector));
}
