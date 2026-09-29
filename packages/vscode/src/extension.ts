import { loadTrustedKeys } from '@ai-dossier/core';
import * as vscode from 'vscode';
import { completionsAt, hoverAt } from './completion';
import { KeyedDebouncer } from './debounce';
import { computeDiagnostics, type DossierDiagnostic } from './diagnostics';
import { dryRunContent, formatDryRun } from './dryrun';
import { buildDossier, slugify } from './template';
import { formatVerifyReport, verifyContent } from './verify';

const SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', pattern: '**/*.ds.md' },
  { scheme: 'untitled', pattern: '**/*.ds.md' },
];
const SOURCE = 'ai-dossier';

// Only real files and unsaved buffers: `git:` diff sides would otherwise get duplicate diagnostics.
const isDossier = (doc: vscode.TextDocument) =>
  (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') && doc.uri.path.endsWith('.ds.md');

const SEVERITY: Record<DossierDiagnostic['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(d: DossierDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(d.range.line, d.range.startCol, d.range.endLine, d.range.endCol);
  const diag = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
  diag.source = SOURCE;
  diag.code = d.code;
  return diag;
}

function lintRules(): Record<string, 'error' | 'warning' | 'info' | 'off'> {
  return vscode.workspace.getConfiguration('aiDossier').get('lint.rules', {});
}

function activeDossier(): vscode.TextDocument | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !isDossier(doc)) {
    void vscode.window.showWarningMessage('Open a *.ds.md dossier file first.');
    return undefined;
  }
  return doc;
}

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection(SOURCE);
  const output = vscode.window.createOutputChannel('AI Dossier');
  context.subscriptions.push(collection, output);

  const debouncer = new KeyedDebouncer();
  const refresh = (doc: vscode.TextDocument) => {
    if (!isDossier(doc)) return;
    const cfg = vscode.workspace.getConfiguration('aiDossier');
    if (!cfg.get<boolean>('validate.enable', true)) {
      collection.delete(doc.uri);
      return;
    }
    try {
      collection.set(
        doc.uri,
        computeDiagnostics(doc.getText(), { rules: lintRules() }).map(toDiagnostic)
      );
    } catch (err) {
      // A core bug must never take the editor down; surface it as one diagnostic instead.
      const msg = err instanceof Error ? err.message : String(err);
      collection.set(doc.uri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `AI Dossier: internal error: ${msg}`,
          vscode.DiagnosticSeverity.Warning
        ),
      ]);
    }
  };
  const refreshDebounced = (doc: vscode.TextDocument) => {
    const delay = vscode.workspace
      .getConfiguration('aiDossier')
      .get<number>('validate.debounceMs', 300);
    debouncer.schedule(doc.uri.toString(), delay, () => refresh(doc));
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refreshDebounced(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      debouncer.cancel(doc.uri.toString());
      collection.delete(doc.uri);
    }),
    // Disposed on deactivate: no timer may fire after the extension is torn down.
    debouncer,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiDossier')) vscode.workspace.textDocuments.forEach(refresh);
    })
  );
  vscode.workspace.textDocuments.forEach(refresh);

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        provideCompletionItems(doc, pos) {
          return completionsAt(doc.getText(), pos.line, pos.character).map((c) => {
            const item = new vscode.CompletionItem(
              c.label,
              c.kind === 'property'
                ? vscode.CompletionItemKind.Property
                : vscode.CompletionItemKind.EnumMember
            );
            item.insertText = c.insertText;
            item.detail = c.detail;
            item.documentation = new vscode.MarkdownString(c.documentation);
            item.range = new vscode.Range(pos.line, c.replaceStartCol, pos.line, pos.character);
            return item;
          });
        },
      },
      '"',
      ':',
      ' '
    ),
    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, pos) {
        const h = hoverAt(doc.getText(), pos.line, pos.character);
        return h
          ? new vscode.Hover(
              new vscode.MarkdownString(h.markdown),
              new vscode.Range(pos.line, h.startCol, pos.line, h.endCol)
            )
          : undefined;
      },
    })
  );

  const show = (text: string) => {
    output.clear();
    output.appendLine(text);
    output.show(true);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('aiDossier.verify', async () => {
      const doc = activeDossier();
      if (!doc) return;
      try {
        const report = await verifyContent(doc.getText(), loadTrustedKeys());
        show(formatVerifyReport(report));
        if (report.ok)
          void vscode.window.showInformationMessage(`Dossier verified: ${report.title}`);
        else
          void vscode.window.showErrorMessage(
            'Dossier verification failed. See the AI Dossier output.'
          );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Dossier verify: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),
    vscode.commands.registerCommand('aiDossier.dryRun', () => {
      const doc = activeDossier();
      if (!doc) return;
      try {
        show(formatDryRun(dryRunContent(doc.getText())));
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Dossier dry-run: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),
    vscode.commands.registerCommand('aiDossier.newFromTemplate', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Dossier title',
        placeHolder: 'Deploy a service',
      });
      if (!title) return;
      const objective =
        (await vscode.window.showInputBox({
          prompt: 'One-sentence objective',
          value: `Describe what "${title}" accomplishes and how success is measured.`,
        })) ?? '';
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, `${slugify(title)}.ds.md`) : undefined,
        filters: { Dossier: ['ds.md'] },
      });
      if (!target) return;
      const text = buildDossier({ title, objective, date: new Date().toISOString().slice(0, 10) });
      await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    })
  );
}

export function deactivate(): void {}
