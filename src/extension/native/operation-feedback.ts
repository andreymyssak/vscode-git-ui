import * as vscode from 'vscode';

export function showUpdateBlocked(
  message: string,
  choices: readonly { label: string; run(): Promise<void> }[],
): void {
  void vscode.window
    .showErrorMessage(message, ...choices.map((choice) => choice.label))
    .then(async (label) => {
      const choice = choices.find((item) => item.label === label);

      if (!choice) return;
      try {
        await choice.run();
      } catch (error) {
        await showOperationError(
          error instanceof Error ? error.message : String(error),
        );
      }
    });
}

export function showOperationError(
  message: string,
  sourceControl = false,
): Promise<void> {
  void vscode.window
    .showErrorMessage(
      message,
      sourceControl ? 'Open Source Control' : 'Dismiss',
    )
    .then(async (choice) => {
      if (sourceControl && choice === 'Open Source Control')
        await vscode.commands.executeCommand('workbench.view.scm');
    });

  return Promise.resolve();
}

export function showOperationInfo(message: string): void {
  // A result notification must not keep an already-finished action pending.
  // A primary action also makes VS Code expand the notification by default.
  // Informational toasts still use VS Code's automatic hiding when not hovered
  // or focused; no global notification cleanup is needed.
  void vscode.window.showInformationMessage(message, 'Dismiss');
}

export function showBranchDeleted(
  name: string,
  restore: () => Promise<void>,
  names?: readonly string[],
  failure?: string,
): void {
  const notification = failure
    ? vscode.window.showErrorMessage(failure, 'Restore')
    : vscode.window.showInformationMessage(
        names && names.length > 1
          ? `Deleted ${names.length} branches.`
          : `Deleted branch "${name}".`,
        'Restore',
      );

  void notification.then(async (choice) => {
    if (choice === 'Restore') {
      try {
        await restore();
      } catch (error) {
        await showOperationError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  });
}
