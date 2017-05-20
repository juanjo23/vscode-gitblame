import {GitBlame} from './gitblame';
import {StatusBarView} from './view';
import {GitBlameController} from './controller';
import {findGitPath} from './gitpath';
import {validEditor} from './editorvalidator';
import {TextDecorator} from './textdecorator';
import {window, ExtensionContext, Disposable, StatusBarAlignment, Range,
        workspace, TextEditor, TextDocument, TextEditorSelectionChangeEvent,
        commands, Uri, DecorationRenderOptions} from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {isWebUri} from 'valid-url';

const globalBlamer = new GitBlame();
const relatedLineStyle = <DecorationRenderOptions>{
    isWholeLine: true,
    dark: {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        border: '1px solid rgba(255, 255, 255, 0.2)'
    },
    light: {
        backgroundColor: 'rgba(0, 0, 0, 0.1)',
        border: '1px solid rgba(0, 0, 0, 0.2)'
    }
};

export async function activate(context: ExtensionContext) {

    // Workspace not using a folder. No access to git repo.
    if (!workspace.rootPath) {
        return;
    }

    const workspaceRoot = workspace.rootPath;
    commands.registerCommand('extension.blame', () => {
        showMessage(context, workspaceRoot);
    });

    // Try to find the repo first in the workspace, then in parent directories
    // because sometimes one opens a subdirectory but still wants information
    // about the full repo.
    try {
        const controller = await lookupRepo(context, workspaceRoot);

        // Listen to file changes and invalidate files when they change
        let fileSystemWatcher = workspace.createFileSystemWatcher('**/*', true);

        fileSystemWatcher.onDidChange((uri) => {
            controller.invalidateFile(uri);
        });
        fileSystemWatcher.onDidDelete((uri) => {
            controller.invalidateFile(uri);
        });
    } catch (err) {
        return;
    }
}

async function lookupRepo(context: ExtensionContext, repositoryDirectory: string): Promise<GitBlameController> {
    const repo = await findGitPath(repositoryDirectory);
    const statusBar = window.createStatusBarItem(StatusBarAlignment.Left);
    const gitBlame = globalBlamer.createBlamer(repo.path);
    const controller = new GitBlameController(gitBlame, repo.dir, new StatusBarView(statusBar));

    context.subscriptions.push(controller);
    context.subscriptions.push(gitBlame);

    return Promise.resolve(controller);
}

async function showMessage(context: ExtensionContext, repositoryDirectory: string) {
    const repo = await findGitPath(repositoryDirectory);
    const viewOnlineTitle = 'View';
    const config = workspace.getConfiguration('gitblame');
    const commitUrl = <string>config.get('commitUrl');
    const messageFormat = <string>config.get('infoMessageFormat');
    const editor = window.activeTextEditor;
    const document = editor.document;

    if (!validEditor(editor)) return;

    const gitBlame = globalBlamer.createBlamer(repo.path);
    const lineNumber = editor.selection.active.line + 1; // line is zero based
    const file = path.relative(repo.dir, document.fileName);

    const blameInfo = await gitBlame.getBlameInfo(file);

    if (!blameInfo['lines'].hasOwnProperty(lineNumber)) return;

    const hash = blameInfo['lines'][lineNumber]['hash'];
    const commitInfo = blameInfo['commits'][hash];
    let normalizedCommitInfo = TextDecorator.normalizeCommitInfoTokens(commitInfo);
    let infoMessageArguments = [];
    let urlToUse = null;

    // Add the message
    infoMessageArguments.push(TextDecorator.parseTokens(messageFormat, normalizedCommitInfo));

    if (commitUrl) {
        // If we have a commitUrl we parse it and add it
        let parsedUrl = TextDecorator.parseTokens(commitUrl, {
            'hash': hash
        });

        if (isWebUri(parsedUrl)) {
            urlToUse = Uri.parse(parsedUrl);
        }
        else {
            window.showErrorMessage('Malformed URL in setting gitblame.commitUrl. Must be a valid web url.');
        }

        if (urlToUse) {
            infoMessageArguments.push(viewOnlineTitle);
        }
    }

    // Highlight related lines when opening info window
    const relatedLines = await gitBlame.getCommitBlameLinesByHash(hash, file);
    const ranges = linesToRanges(document, relatedLines);
    const lineDecorator = window.createTextEditorDecorationType(relatedLineStyle);

    editor.setDecorations(lineDecorator, ranges);

    const item = await window.showInformationMessage.apply(this, infoMessageArguments)

    lineDecorator.dispose();

    if (item === viewOnlineTitle) {
        commands.executeCommand('vscode.open', urlToUse);
    }
}

function linesToRanges(document: TextDocument, lineNumbers: Array<string>): Array<Range> {
    let ranges = [];

    for (let i = 0; i < lineNumbers.length; i++) {
        const lineNumber = parseInt(lineNumbers[i], 10);
        if (ranges.length && (ranges[ranges.length - 1].end.line + 1) === lineNumber) {
            ranges[ranges.length - 1] = ranges[ranges.length - 1].union(document.lineAt(lineNumber).range);
        }
        else {
            ranges.push(document.lineAt(lineNumber).range);
        }
    }

    return ranges;
}

