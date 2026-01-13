const vscode = require('vscode');

const ENTRYPOINT_RE = /@entrypoint\b/;
const FN_RE = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/;
const MAX_LOOKAHEAD = 6;

class EntrypointCodeLensProvider {
    constructor(runCommand, buildCommand) {
        this.runCommand = runCommand;
        this.buildCommand = buildCommand;
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    }

    refresh() {
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.CodeLens[]}
     */
    provideCodeLenses(document) {
        if (document.uri.scheme !== 'file' || document.languageId !== 'surge') {
            return [];
        }
        const lenses = [];
        const seenLines = new Set();
        const lineCount = document.lineCount;
        for (let i = 0; i < lineCount; i++) {
            const text = document.lineAt(i).text;
            if (!ENTRYPOINT_RE.test(text)) {
                continue;
            }
            let targetLine = i;
            const last = Math.min(lineCount, i + MAX_LOOKAHEAD);
            for (let j = i; j < last; j++) {
                const candidate = document.lineAt(j).text;
                if (FN_RE.test(candidate)) {
                    targetLine = j;
                    break;
                }
            }
            if (seenLines.has(targetLine)) {
                continue;
            }
            seenLines.add(targetLine);
            const range = new vscode.Range(targetLine, 0, targetLine, 0);
            lenses.push(new vscode.CodeLens(range, {
                title: 'Run',
                command: this.runCommand,
                arguments: [document.uri],
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: 'Build',
                command: this.buildCommand,
                arguments: [document.uri],
            }));
        }
        return lenses;
    }
}

module.exports = { EntrypointCodeLensProvider };
