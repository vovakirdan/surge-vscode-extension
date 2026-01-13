const vscode = require('vscode');

const CONFIG_SECTION = 'surge';
const SERVER_PATH_KEY = 'serverPath';

function getStringSetting(key, fallback) {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const value = config.get(key, fallback);
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

function getSurgePath() {
    return getStringSetting(SERVER_PATH_KEY, 'surge');
}

module.exports = {
    CONFIG_SECTION,
    SERVER_PATH_KEY,
    getStringSetting,
    getSurgePath,
};
