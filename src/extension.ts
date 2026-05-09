import * as vscode from "vscode";
import { normalizeLocale, translate } from "./i18n/messages";
import { UsageViewProvider } from "./providers/UsageViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new UsageViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.commands.registerCommand("aiCodingUsage.refresh", async () => {
      await provider.refresh({ allowSourcePrompt: true, forceImport: true });
      vscode.window.setStatusBarMessage(translate(normalizeLocale(vscode.env.language), "status.refreshed"), 2000);
    }),
    vscode.commands.registerCommand("aiCodingUsage.openDashboard", () => provider.reveal()),
    vscode.commands.registerCommand("aiCodingUsage.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "aiCodingUsage"),
    ),
    vscode.commands.registerCommand("aiCodingUsage.detectLocalSources", () => provider.detectLocalSources()),
  );
}

export function deactivate(): void {
  // No runtime resources to dispose yet.
}
