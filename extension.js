const vscode = require('vscode');
const { LanguageClient, State } = require('vscode-languageclient/node');

const CONFIG_SECTION = 'surge';
const SERVER_PATH_KEY = 'serverPath';

let client;
let outputChannel;
let statusBar;
let notifiedMissing = false;

function getServerPath() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const configured = config.get(SERVER_PATH_KEY, 'surge');
    if (typeof configured !== 'string') {
        return 'surge';
    }
    const trimmed = configured.trim();
    return trimmed.length > 0 ? trimmed : 'surge';
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

async function startClient(context) {
    const serverPath = getServerPath();
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
    };

    client = new LanguageClient(
        'surgeLanguageServer',
        'Surge Language Server',
        serverOptions,
        clientOptions
    );

    client.onDidChangeState((event) => updateStatus(event.newState));
    void client.start().then(
        () => {
            notifiedMissing = false;
        },
        (err) => {
            handleClientError(err, serverPath);
        }
    );
}

async function stopClient() {
    if (!client) {
        updateStatus(State.Stopped);
        return;
    }
    const current = client;
    client = undefined;
    try {
        await current.stop();
    } catch (err) {
        if (outputChannel) {
            outputChannel.appendLine(`[warn] Failed to stop language server: ${err.message || err}`);
        }
    }
    updateStatus(State.Stopped);
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

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Surge Language Server');
    context.subscriptions.push(outputChannel);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'surge.restartLanguageServer';
    statusBar.text = 'Surge LSP: stopped';
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('surge.restartLanguageServer', () => restartClient(context))
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${CONFIG_SECTION}.${SERVER_PATH_KEY}`)) {
                notifiedMissing = false;
                restartClient(context);
            }
        })
    );

    startClient(context);
}

function deactivate() {
    return stopClient();
}

module.exports = {
    activate,
    deactivate,
};
