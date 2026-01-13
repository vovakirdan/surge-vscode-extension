const vscode = require('vscode');

const { getSurgePath, getStringSetting } = require('./surge_config');

const RUN_COMMAND = 'surge.runEntryPoint';
const BUILD_COMMAND = 'surge.buildEntryPoint';
const RUN_BACKEND_KEY = 'run.backend';
const BUILD_BACKEND_KEY = 'build.backend';

let surgeTerminal;

function quoteArg(value) {
    if (value === '') {
        return '""';
    }
    if (!/[\s"]/.test(value)) {
        return value;
    }
    return `"${value.replace(/"/g, '\\"')}"`;
}

function getBackend(key, fallback) {
    return getStringSetting(key, fallback);
}

function getTerminal(document) {
    if (surgeTerminal) {
        return surgeTerminal;
    }
    const options = { name: 'Surge' };
    if (document) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (folder && folder.uri && folder.uri.scheme === 'file') {
            options.cwd = folder.uri.fsPath;
        }
    }
    surgeTerminal = vscode.window.createTerminal(options);
    return surgeTerminal;
}

async function resolveDocument(uri) {
    if (uri && uri.scheme) {
        return vscode.workspace.openTextDocument(uri);
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        return editor.document;
    }
    return null;
}

async function runSurgeCommand(kind, uri) {
    const document = await resolveDocument(uri);
    if (!document) {
        vscode.window.showErrorMessage('No active Surge document to run.');
        return;
    }
    if (document.uri.scheme !== 'file') {
        vscode.window.showErrorMessage('Surge run/build only supports files on disk.');
        return;
    }
    if (document.languageId !== 'surge') {
        vscode.window.showErrorMessage('Active document is not a Surge file.');
        return;
    }
    if (document.isDirty) {
        const saved = await document.save();
        if (!saved) {
            vscode.window.showErrorMessage('Failed to save the document before running.');
            return;
        }
    }

    const filePath = document.uri.fsPath;
    if (!filePath) {
        vscode.window.showErrorMessage('Unable to resolve file path for the current document.');
        return;
    }

    const backend = kind === 'run'
        ? getBackend(RUN_BACKEND_KEY, 'vm')
        : getBackend(BUILD_BACKEND_KEY, 'llvm');
    const surgePath = getSurgePath();
    const command = `${quoteArg(surgePath)} ${kind} ${quoteArg(filePath)} --backend ${quoteArg(backend)}`;
    const terminal = getTerminal(document);
    terminal.show(true);
    terminal.sendText(command, true);
}

function registerRunBuildCommands(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(RUN_COMMAND, (uri) => runSurgeCommand('run', uri))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(BUILD_COMMAND, (uri) => runSurgeCommand('build', uri))
    );
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
            if (terminal === surgeTerminal) {
                surgeTerminal = undefined;
            }
        })
    );
}

module.exports = {
    BUILD_COMMAND,
    RUN_COMMAND,
    registerRunBuildCommands,
};
