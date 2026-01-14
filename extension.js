const vscode = require('vscode');
const { LanguageClient, State, ErrorAction, CloseAction } = require('vscode-languageclient/node');
const { EntrypointCodeLensProvider } = require('./codelens_entrypoint');
const { registerRunBuildCommands, RUN_COMMAND, BUILD_COMMAND } = require('./commands_run_build');
const { CONFIG_SECTION, SERVER_PATH_KEY, getSurgePath } = require('./surge_config');

const LSP_ENABLED_KEY = 'lsp.enabled';

let client;
let outputChannel;
let statusBar;
let notifiedMissing = false;
let desiredEnabled = true;
let manualStopInProgress = false;
let startInProgress = false;

function log(message) {
    if (outputChannel) {
        outputChannel.appendLine(message);
    }
}

function getLspEnabled() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const enabled = config.get(LSP_ENABLED_KEY, true);
    return typeof enabled === 'boolean' ? enabled : true;
}

function isClientRunning() {
    return client && client.state === State.Running;
}

function stateLabel(state) {
    switch (state) {
        case State.Running:
            return 'running';
        case State.Starting:
            return 'starting';
        case State.Stopped:
        default:
            return 'stopped';
    }
}

function updateStatus(state) {
    if (!statusBar) {
        return;
    }
    switch (state) {
        case State.Running:
            statusBar.text = 'Surge LSP: running';
            break;
        case State.Starting:
            statusBar.text = 'Surge LSP: starting';
            break;
        case State.Stopped:
        default:
            statusBar.text = 'Surge LSP: stopped';
            break;
    }
}

function createErrorHandler() {
    return {
        error: (err) => {
            log(`[error] ${err && err.message ? err.message : String(err)}`);
            return ErrorAction.Continue;
        },
        closed: () => {
            if (!desiredEnabled || manualStopInProgress) {
                log('[info] LSP closed without restart (disabled or manual stop).');
                return CloseAction.DoNotRestart;
            }
            log('[info] LSP closed; restarting.');
            return CloseAction.Restart;
        },
    };
}

async function startClient(context) {
    if (startInProgress || client) {
        return;
    }
    if (!desiredEnabled) {
        updateStatus(State.Stopped);
        log('[info] LSP start skipped (disabled).');
        return;
    }
    startInProgress = true;
    manualStopInProgress = false;
    const serverPath = getSurgePath();
    const serverOptions = {
        command: serverPath,
        args: ['lsp'],
        options: { env: process.env },
    };
    const clientOptions = {
        documentSelector: [
            { language: 'surge', scheme: 'file' },
            { language: 'surge', scheme: 'untitled' },
        ],
        synchronize: {
            configurationSection: CONFIG_SECTION,
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.sg'),
        },
        outputChannel,
        errorHandler: createErrorHandler(),
    };

    client = new LanguageClient(
        'surgeLanguageServer',
        'Surge Language Server',
        serverOptions,
        clientOptions
    );

    client.onDidChangeState((event) => {
        updateStatus(event.newState);
        log(`[info] LSP state: ${stateLabel(event.newState)}`);
    });
    try {
        await client.start();
        notifiedMissing = false;
        log('[info] LSP started.');
    } catch (err) {
        handleClientError(err, serverPath);
        client = undefined;
    } finally {
        startInProgress = false;
    }
}

async function stopClient() {
    if (!client) {
        updateStatus(State.Stopped);
        return;
    }
    const current = client;
    client = undefined;
    manualStopInProgress = true;
    log('[info] LSP stopping...');
    try {
        await current.stop();
    } catch (err) {
        if (outputChannel) {
            outputChannel.appendLine(`[warn] Failed to stop language server: ${err.message || err}`);
        }
    }
    manualStopInProgress = false;
    updateStatus(State.Stopped);
    log('[info] LSP stopped.');
}

async function restartClient(context) {
    await stopClient();
    await startClient(context);
}

function handleClientError(err, serverPath) {
    updateStatus(State.Stopped);
    if (outputChannel) {
        outputChannel.appendLine(`[error] ${err && err.message ? err.message : String(err)}`);
    }
    if (notifiedMissing) {
        return;
    }
    let message = 'Unable to start the Surge language server.';
    if (err && err.code === 'ENOENT') {
        message = `Unable to launch Surge language server. "${serverPath}" was not found. Install Surge or set "surge.serverPath".`;
    } else {
        message = 'Unable to start the Surge language server. Check the Output panel for details.';
    }
    vscode.window.showErrorMessage(message);
    notifiedMissing = true;
}

async function showStatusMenu(context) {
    const running = isClientRunning();
    const enabled = desiredEnabled;
    const items = [
        { label: `State: ${running ? 'Running' : 'Stopped'}`, kind: vscode.QuickPickItemKind.Separator },
        { label: 'Start', id: 'start', description: enabled ? '' : 'disabled in settings' },
        { label: 'Stop', id: 'stop' },
        { label: 'Restart', id: 'restart' },
    ];
    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Surge Language Server',
    });
    if (!selection || !selection.id) {
        return;
    }
    switch (selection.id) {
        case 'start':
            if (!desiredEnabled) {
                vscode.window.showErrorMessage('Surge LSP is disabled. Enable "surge.lsp.enabled" to start it.');
                return;
            }
            await startClient(context);
            return;
        case 'stop':
            await stopClient();
            return;
        case 'restart':
            await restartClient(context);
            return;
        default:
            return;
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Surge Language Server');
    context.subscriptions.push(outputChannel);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'surge.lsp.menu';
    statusBar.text = 'Surge LSP: stopped';
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('surge.restartLanguageServer', () => restartClient(context))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('surge.lsp.start', () => startClient(context))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('surge.lsp.stop', () => stopClient())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('surge.lsp.restart', () => restartClient(context))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('surge.lsp.menu', () => showStatusMenu(context))
    );

    registerRunBuildCommands(context);

    const entrypointProvider = new EntrypointCodeLensProvider(RUN_COMMAND, BUILD_COMMAND);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'surge', scheme: 'file' }, entrypointProvider)
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const doc = event.document;
            if (doc.languageId === 'surge' && doc.uri.scheme === 'file') {
                entrypointProvider.refresh();
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.languageId === 'surge' && doc.uri.scheme === 'file') {
                entrypointProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            const enabledChanged = event.affectsConfiguration(`${CONFIG_SECTION}.${LSP_ENABLED_KEY}`);
            const serverPathChanged = event.affectsConfiguration(`${CONFIG_SECTION}.${SERVER_PATH_KEY}`);
            if (enabledChanged) {
                desiredEnabled = getLspEnabled();
                if (!desiredEnabled) {
                    log('[info] LSP disabled via settings.');
                    stopClient();
                } else {
                    log('[info] LSP enabled via settings.');
                    startClient(context);
                }
            }
            if (serverPathChanged) {
                notifiedMissing = false;
                if (desiredEnabled) {
                    restartClient(context);
                }
            }
        })
    );

    desiredEnabled = getLspEnabled();
    if (desiredEnabled) {
        startClient(context);
    } else {
        updateStatus(State.Stopped);
        log('[info] LSP disabled on startup.');
    }
}

function deactivate() {
    return stopClient();
}

module.exports = {
    activate,
    deactivate,
};
