const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SURGE_SOURCE = 'surge';
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_DIAGNOSTICS = 200;
const ANALYZER_TEMP_DIR = path.join(os.tmpdir(), 'surge-vscode');

function normalizeFsPath(fsPath) {
    if (!fsPath) {
        return undefined;
    }
    const candidate = path.isAbsolute(fsPath) ? fsPath : path.resolve(fsPath);
    const normalized = path.normalize(candidate);
    if (process.platform === 'win32') {
        return normalized.toLowerCase();
    }
    return normalized;
}

class SurgeAnalyzer {
    constructor(context, diagnosticCollection) {
        this.context = context;
        this.diagnosticCollection = diagnosticCollection;
        this.debounceHandles = new Map();
        this.output = vscode.window.createOutputChannel('Surge Analyzer');
        this.available = undefined;
        this.notifiedMissing = false;
        this.diagnosticFixes = new WeakMap();
        this.commandPath = this.getExecutablePath();

        context.subscriptions.push(this.output);
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('surge.analyzer.executablePath')) {
                    this.commandPath = this.getExecutablePath();
                    this.available = undefined;
                    this.notifiedMissing = false;
                    this.output.appendLine(`[info] Surge executable path changed to "${this.commandPath}".`);
                    vscode.workspace.textDocuments.forEach((doc) => this.trigger(doc));
                }
            })
        );

        this.ensureTempDir().catch((err) => {
            this.output.appendLine(`[warn] Unable to prepare surge temp directory: ${err.message}`);
        });
    }

    getExecutablePath() {
        const config = vscode.workspace.getConfiguration('surge');
        const configured = config.get('analyzer.executablePath', 'surge');
        if (typeof configured !== 'string' || configured.trim().length === 0) {
            return 'surge';
        }
        return configured.trim();
    }

    trigger(document) {
        if (!document || document.languageId !== 'surge') {
            return;
        }
        if (this.available === false) {
            return;
        }
        const key = document.uri.toString();
        const existing = this.debounceHandles.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const handle = setTimeout(() => {
            this.debounceHandles.delete(key);
            this.runAnalysis(document);
        }, DEFAULT_DEBOUNCE_MS);
        this.debounceHandles.set(key, handle);
    }

    async runAnalysis(document) {
        if (this.available === false) {
            return;
        }
        const version = document.version;
        const content = document.getText();
        let contextInfo;

        try {
            contextInfo = await this.prepareInput(document, content);
        } catch (err) {
            this.output.appendLine(`[error] Failed to prepare diagnostics input: ${err.message}`);
            return;
        }

        if (!contextInfo) {
            return;
        }

        let result;
        try {
            result = await this.invokeSurge(contextInfo, document);
        } finally {
            if (contextInfo.cleanup) {
                try {
                    await contextInfo.cleanup();
                } catch (cleanupErr) {
                    this.output.appendLine(`[warn] Failed to clean surge temp file: ${cleanupErr.message}`);
                }
            }
        }

        if (!result) {
            return;
        }

        if (document.version !== version || document.isClosed) {
            return;
        }

        if (result.stderr && result.stderr.trim().length > 0) {
            this.output.appendLine(`[surge] ${result.stderr.trim()}`);
        }
        if (result.exitCode > 1) {
            this.output.appendLine(`[error] surge diag exited with code ${result.exitCode}.`);
        }

        const diagnostics = this.parseDiagnostics(result.stdout, document, contextInfo);
        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    async prepareInput(document, content) {
        const docPath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
        const normalizedDocPath = normalizeFsPath(docPath);

        if (docPath && !document.isUntitled && !document.isDirty) {
            return {
                path: docPath,
                normalizedAnalysisPath: normalizedDocPath,
                normalizedDocumentPath: normalizedDocPath,
                cleanup: null,
            };
        }

        const tempPath = await this.createTempFile(document, content, docPath);
        return {
            path: tempPath,
            normalizedAnalysisPath: normalizeFsPath(tempPath),
            normalizedDocumentPath: normalizedDocPath,
            cleanup: () => this.deleteTempFile(tempPath),
        };
    }

    async createTempFile(document, content, originalPath) {
        await this.ensureTempDir();
        const parsed = originalPath ? path.parse(originalPath) : { name: 'untitled', ext: '.sg' };
        const name = parsed && parsed.name ? parsed.name : 'untitled';
        const ext = parsed && parsed.ext ? parsed.ext : '.sg';
        const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        const fileName = `${name}-${unique}${ext}`;
        const tempPath = path.join(ANALYZER_TEMP_DIR, fileName);
        await fs.promises.writeFile(tempPath, content, 'utf8');
        return tempPath;
    }

    async deleteTempFile(filePath) {
        try {
            await fs.promises.unlink(filePath);
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                this.output.appendLine(`[warn] Unable to remove surge temp file "${filePath}": ${err.message}`);
            }
        }
    }

    invokeSurge(contextInfo, document) {
        const analysisPath = contextInfo?.path;
        if (!analysisPath) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            const args = [
                'diag',
                '--format',
                'json',
                '--stages',
                'sema',
                '--max-diagnostics',
                String(DEFAULT_MAX_DIAGNOSTICS),
                '--with-notes',
                '--suggest',
                '--preview',
                '--fullpath',
                analysisPath,
            ];
            const spawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] };
            const workingDirectory = this.getWorkingDirectory(document, contextInfo);
            if (workingDirectory) {
                spawnOptions.cwd = workingDirectory;
            }
            const proc = cp.spawn(this.commandPath, args, spawnOptions);
            let stderr = '';
            let stdout = '';
            let finished = false;

            const finish = (value) => {
                if (!finished) {
                    finished = true;
                    resolve(value);
                }
            };

            proc.on('error', (err) => {
                if (err && err.code === 'ENOENT') {
                    this.available = false;
                    if (!this.notifiedMissing) {
                        this.notifiedMissing = true;
                        vscode.window.showWarningMessage('Surge executable not found. Semantic analysis is disabled.');
                    }
                    this.diagnosticCollection.clear();
                    finish(null);
                    return;
                }
                this.output.appendLine(`[error] Failed to run surge: ${err.message}`);
                finish(null);
            });

            proc.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            proc.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            proc.on('close', (code) => {
                if (this.available !== false) {
                    this.available = true;
                }
                const exitCode = typeof code === 'number' ? code : 0;
                finish({ stdout, stderr, exitCode });
            });
        });
    }

    getWorkingDirectory(document, contextInfo) {
        if (contextInfo?.normalizedDocumentPath) {
            return path.dirname(contextInfo.normalizedDocumentPath);
        }
        if (document?.uri) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (workspaceFolder?.uri?.scheme === 'file') {
                return workspaceFolder.uri.fsPath;
            }
        }
        if (contextInfo?.normalizedAnalysisPath) {
            return path.dirname(contextInfo.normalizedAnalysisPath);
        }
        if (contextInfo?.path) {
            return path.dirname(contextInfo.path);
        }
        return undefined;
    }

    parseDiagnostics(stdout, document, contextInfo) {
        if (!stdout || stdout.trim().length === 0) {
            return [];
        }

        let payload;
        try {
            payload = JSON.parse(stdout);
        } catch (err) {
            this.output.appendLine(`[error] Failed to parse surge diagnostics JSON: ${err.message}`);
            return [];
        }

        const items = Array.isArray(payload?.diagnostics) ? payload.diagnostics : [];
        if (!Array.isArray(items) || items.length === 0) {
            return [];
        }

        const targetPaths = new Set();
        if (contextInfo.normalizedDocumentPath) {
            targetPaths.add(contextInfo.normalizedDocumentPath);
        }
        if (contextInfo.normalizedAnalysisPath) {
            targetPaths.add(contextInfo.normalizedAnalysisPath);
        }

        const diagnostics = [];
        for (const item of items) {
            if (!item || !item.location) {
                continue;
            }
            const locationPath = normalizeFsPath(item.location.file);
            if (targetPaths.size > 0 && locationPath && !targetPaths.has(locationPath)) {
                continue;
            }
            const range = this.createRangeFromLocation(document, item.location);
            if (!range) {
                continue;
            }
            const severity = this.mapSeverity(item.severity);
            const diagnostic = new vscode.Diagnostic(range, item.message, severity);
            diagnostic.source = SURGE_SOURCE;
            if (item.code) {
                diagnostic.code = item.code;
            }
            const related = this.buildRelatedInformation(document, item.notes, targetPaths);
            if (related.length > 0) {
                diagnostic.relatedInformation = related;
            }
            if (Array.isArray(item.fixes) && item.fixes.length > 0) {
                this.diagnosticFixes.set(diagnostic, item.fixes);
            }
            diagnostics.push(diagnostic);
        }
        return diagnostics;
    }

    mapSeverity(kind) {
        const normalized = typeof kind === 'string' ? kind.toUpperCase() : '';
        switch (normalized) {
            case 'WARNING':
                return vscode.DiagnosticSeverity.Warning;
            case 'NOTE':
            case 'INFO':
                return vscode.DiagnosticSeverity.Information;
            case 'ERROR':
            default:
                return vscode.DiagnosticSeverity.Error;
        }
    }

    buildRelatedInformation(document, notes, targetPaths) {
        if (!Array.isArray(notes) || notes.length === 0) {
            return [];
        }
        const related = [];
        for (const note of notes) {
            if (!note || !note.location) {
                continue;
            }
            const locationPath = normalizeFsPath(note.location.file);
            if (targetPaths.size > 0 && locationPath && !targetPaths.has(locationPath)) {
                continue;
            }
            const range = this.createRangeFromLocation(document, note.location);
            if (!range) {
                continue;
            }
            related.push(
                new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(document.uri, range),
                    note.message || ''
                )
            );
        }
        return related;
    }

    getFixesForDiagnostic(diagnostic) {
        if (!diagnostic) {
            return [];
        }
        const fixes = this.diagnosticFixes.get(diagnostic);
        return Array.isArray(fixes) ? fixes : [];
    }

    createRangeFromLocation(document, location) {
        const startLine = this.toZeroBased(location?.start_line ?? location?.startLine);
        const startCol = this.toZeroBased(location?.start_col ?? location?.startCol);
        if (startLine === null || startCol === null) {
            return null;
        }
        let endLine = this.toZeroBased(location?.end_line ?? location?.endLine);
        let endCol = this.toZeroBased(location?.end_col ?? location?.endCol);
        if (endLine === null) {
            endLine = startLine;
        }
        if (endCol === null) {
            endCol = startCol;
        }

        const lastLineIndex = Math.max(0, document.lineCount - 1);
        const clampedStartLine = Math.min(Math.max(startLine, 0), lastLineIndex);
        let clampedEndLine = Math.min(Math.max(endLine, 0), lastLineIndex);

        let startLineText;
        try {
            startLineText = document.lineAt(clampedStartLine).text;
        } catch (err) {
            return null;
        }

        let endLineText;
        try {
            endLineText = document.lineAt(clampedEndLine).text;
        } catch (err) {
            clampedEndLine = clampedStartLine;
            endLineText = startLineText;
        }

        const startCharacter = Math.min(Math.max(startCol, 0), startLineText.length);
        let endCharacter = Math.min(Math.max(endCol, 0), endLineText.length);

        if (clampedStartLine === clampedEndLine && endCharacter <= startCharacter) {
            if (startCharacter < startLineText.length) {
                endCharacter = startCharacter + 1;
            }
        }

        return new vscode.Range(
            new vscode.Position(clampedStartLine, startCharacter),
            new vscode.Position(clampedEndLine, endCharacter)
        );
    }

    toZeroBased(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(0, value - 1);
        }
        if (typeof value === 'string') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
                return Math.max(0, parsed - 1);
            }
        }
        return null;
    }

    ensureTempDir() {
        return fs.promises.mkdir(ANALYZER_TEMP_DIR, { recursive: true });
    }
}

class SurgeCodeActionProvider {
    constructor(analyzer) {
        this.analyzer = analyzer;
    }

    provideCodeActions(document, _range, context) {
        if (!context || !Array.isArray(context.diagnostics)) {
            return [];
        }
        const actions = [];
        for (const diagnostic of context.diagnostics) {
            if (!diagnostic || diagnostic.source !== SURGE_SOURCE) {
                continue;
            }
            const fixes = this.analyzer.getFixesForDiagnostic(diagnostic);
            if (!Array.isArray(fixes) || fixes.length === 0) {
                continue;
            }
            for (const fix of fixes) {
                const action = this.buildAction(document, diagnostic, fix);
                if (action) {
                    actions.push(action);
                }
            }
        }
        return actions;
    }

    buildAction(document, diagnostic, fix) {
        if (!Array.isArray(fix?.edits) || fix.edits.length === 0) {
            return null;
        }
        const edit = new vscode.WorkspaceEdit();
        let applied = false;
        const docUri = document?.uri;
        const documentPath = docUri ? normalizeFsPath(docUri.fsPath) : undefined;
        if (!docUri) {
            return null;
        }

        for (const change of fix.edits) {
            const targetPath = normalizeFsPath(change?.location?.file || docUri.fsPath);
            if (targetPath && documentPath && targetPath !== documentPath) {
                continue;
            }
            const range = this.analyzer.createRangeFromLocation(document, change.location);
            if (!range) {
                continue;
            }
            const newText = typeof change.new_text === 'string' ? change.new_text : '';
            edit.replace(docUri, range, newText);
            applied = true;
        }

        if (!applied) {
            return null;
        }

        const action = new vscode.CodeAction(
            fix.title || 'Apply Surge fix',
            vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.edit = edit;

        const preferred = typeof fix.isPreferred === 'boolean' ? fix.isPreferred : fix.is_preferred;
        if (typeof preferred === 'boolean') {
            action.isPreferred = preferred;
        }

        const documentation = this.buildDocumentation(fix);
        if (documentation.length > 0) {
            action.documentation = documentation;
        }

        return action;
    }

    buildDocumentation(fix) {
        const docs = [];
        for (const change of fix.edits) {
            const beforeLines = Array.isArray(change?.before_lines) ? change.before_lines.join('\n') : null;
            const afterLines = Array.isArray(change?.after_lines) ? change.after_lines.join('\n') : null;
            if (!beforeLines && !afterLines) {
                continue;
            }
            const md = new vscode.MarkdownString();
            if (beforeLines) {
                md.appendMarkdown('**Before**\n');
                md.appendCodeblock(beforeLines, 'surge');
            }
            if (afterLines) {
                md.appendMarkdown('**After**\n');
                md.appendCodeblock(afterLines, 'surge');
            }
            docs.push(md);
            break;
        }
        return docs;
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection(SURGE_SOURCE);
    context.subscriptions.push(diagnosticCollection);

    const analyzer = new SurgeAnalyzer(context, diagnosticCollection);
    const codeActionProvider = new SurgeCodeActionProvider(analyzer);

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => analyzer.trigger(doc))
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => analyzer.trigger(event.document))
    );
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => analyzer.trigger(doc))
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => diagnosticCollection.delete(doc.uri))
    );
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            [{ language: 'surge' }],
            codeActionProvider,
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );

    vscode.workspace.textDocuments.forEach((doc) => analyzer.trigger(doc));
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
};
