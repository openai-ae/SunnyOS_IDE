/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as os from 'os';
import * as vscode from 'vscode';
import { commands, DiagnosticSeverity, env, ExtensionContext, languages, modelSelection, window, workspace, } from 'vscode';

import { createInlineCompletionItemProvider } from './completions/create-inline-completion-item-provider';
import { CSChatAgentProvider } from './completions/providers/chatprovider';
import { AideProbeProvider } from './completions/providers/probeProvider';
import { getGitCurrentHash, getGitRepoName } from './git/helper';
import { aideCommands } from './inlineCompletion/commands';
import { startupStatusBar } from './inlineCompletion/statusBar';
import logger from './logger';
import postHogClient from './posthog/client';
import { AideQuickFix } from './quickActions/fix';
import { RepoRef, RepoRefBackend, SideCarClient } from './sidecar/client';
import { loadOrSaveToStorage } from './storage/types';
import { copySettings } from './utilities/copySettings';
import { getRelevantFiles, shouldTrackFile } from './utilities/openTabs';
import { checkReadonlyFSMode } from './utilities/readonlyFS';
import { reportIndexingPercentage } from './utilities/reportIndexingUpdate';
import { startSidecarBinary } from './utilities/setupSidecarBinary';
import { readCustomSystemInstruction } from './utilities/systemInstruction';
import { CodeSymbolInformationEmbeddings } from './utilities/types';
import { getUniqueId } from './utilities/uniqueId';
import { ProjectContext } from './utilities/workspaceContext';
import { CSEventHandler } from './csEvents/csEventHandler';
import { RecentEditsRetriever } from './server/editedFiles';
import { GENERATE_PLAN } from './completions/providers/generatePlan';
import { OPEN_FILES_VARIABLE } from './completions/providers/openFiles';

export let SIDECAR_CLIENT: SideCarClient | null = null;

export async function activate(context: ExtensionContext) {
	// Project root here
	const uniqueUserId = getUniqueId();
	logger.info(`[CodeStory]: ${uniqueUserId} Activating extension with storage: ${context.globalStorageUri}`);
	postHogClient?.capture({
		distinctId: getUniqueId(),
		event: 'extension_activated',
		properties: {
			platform: os.platform(),
		},
	});

	const registerPreCopyCommand = commands.registerCommand(
		'webview.preCopySettings',
		async () => {
			await copySettings(env.appRoot, logger);
		}
	);
	context.subscriptions.push(registerPreCopyCommand);
	let rootPath = workspace.rootPath;
	if (!rootPath) {
		rootPath = '';
	}

	// Create the copy settings from vscode command for the extension
	const registerCopySettingsCommand = commands.registerCommand(
		'webview.copySettings',
		async () => {
			await copySettings(rootPath ?? '', logger);
		}
	);
	context.subscriptions.push(registerCopySettingsCommand);
	const readonlyFS = checkReadonlyFSMode();
	if (readonlyFS) {
		window.showErrorMessage('Move Aide to the Applications folder using Finder. More instructions here: [link](https://docs.codestory.ai/troubleshooting#macos-readonlyfs-warning)');
		return;
	}
	const agentSystemInstruction = readCustomSystemInstruction();
	if (agentSystemInstruction === null) {
		console.log(
			'Aide can help you better if you give it custom instructions by going to your settings and setting it in aide.systemInstruction (search for this string in User Settings) and reload vscode for this to take effect by doing Cmd+Shift+P: Developer: Reload Window'
		);
	}

	// Now we get all the required information and log it
	const repoName = await getGitRepoName(
		rootPath,
	);
	const repoHash = await getGitCurrentHash(
		rootPath,
	);

	// We also get some context about the workspace we are in and what we are
	// upto
	const projectContext = new ProjectContext();
	await projectContext.collectContext();

	postHogClient?.capture({
		distinctId: await getUniqueId(),
		event: 'activated_lsp',
		properties: {
			repoName,
			repoHash,
		}
	});

	// Get model selection configuration
	const modelConfiguration = await modelSelection.getConfiguration();
	// Setup the sidecar client here
	const sidecarUrl = await startSidecarBinary(context.globalStorageUri.fsPath, env.appRoot);
	// allow-any-unicode-next-line
	// window.showInformationMessage(`Sidecar binary 🦀 started at ${sidecarUrl}`);
	const sidecarClient = new SideCarClient(sidecarUrl, modelConfiguration);
	SIDECAR_CLIENT = sidecarClient;

	// we want to send the open tabs here to the sidecar
	const openTextDocuments = await getRelevantFiles();
	openTextDocuments.forEach((openTextDocument) => {
		// not awaiting here so we can keep loading the extension in the background
		if (shouldTrackFile(openTextDocument.uri)) {
			sidecarClient.documentOpen(openTextDocument.uri.fsPath, openTextDocument.contents, openTextDocument.language);
		}
	});
	// Setup the current repo representation here
	const currentRepo = new RepoRef(
		// We assume the root-path is the one we are interested in
		rootPath,
		RepoRefBackend.local,
	);
	// setup the callback for the model configuration
	modelSelection.onDidChangeConfiguration((config) => {
		sidecarClient.updateModelConfiguration(config);
		// console.log('Model configuration updated:' + JSON.stringify(config));
	});
	await sidecarClient.indexRepositoryIfNotInvoked(currentRepo);
	// Show the indexing percentage on startup
	await reportIndexingPercentage(sidecarClient, currentRepo);

	// register the inline code completion provider
	await createInlineCompletionItemProvider(
		{
			triggerNotice: notice => {
				console.log(notice);
			},
			sidecarClient,
		}
	);
	// register the commands here for inline completion
	aideCommands();
	// set the status bar as well
	startupStatusBar();

	// Get the storage object here
	const codeStoryStorage = await loadOrSaveToStorage(context.globalStorageUri.fsPath, rootPath);
	logger.info(codeStoryStorage);
	logger.info(rootPath);


	// Register the semantic search command here
	commands.registerCommand('codestory.semanticSearch', async (prompt: string): Promise<CodeSymbolInformationEmbeddings[]> => {
		logger.info('[semanticSearch][extension] We are executing semantic search :' + prompt);
		postHogClient?.capture({
			distinctId: await getUniqueId(),
			event: 'search',
			properties: {
				prompt,
				repoName,
				repoHash,
			},
		});
		// We should be using the searchIndexCollection instead here, but for now
		// embedding search is fine
		// Here we will ping the semantic client instead so we can get the results
		const results = await sidecarClient.getSemanticSearchResult(
			prompt,
			currentRepo,
		);
		return results;
	});

	// Register the quick action providers
	const aideQuickFix = new AideQuickFix();
	languages.registerCodeActionsProvider('*', aideQuickFix);

	// add the recent edits retriver to the subscriptions
	// so we can grab the recent edits very quickly
	const recentEditsRetriever = new RecentEditsRetriever(300 * 1000, workspace);
	context.subscriptions.push(recentEditsRetriever);

	const probeProvider = new AideProbeProvider(sidecarClient, rootPath, recentEditsRetriever);
	const editorUrl = probeProvider.editorUrl();
	context.subscriptions.push(probeProvider);

	// Register feedback commands
	context.subscriptions.push(
		commands.registerCommand('codestory.feedback', async () => {
			// Redirect to Discord server link
			await commands.executeCommand('vscode.open', 'https://discord.gg/FdKXRDGVuz');
		})
	);

	// When the selection changes in the editor we should trigger an event
	window.onDidChangeTextEditorSelection(async (event) => {
		const textEditor = event.textEditor;
		if (shouldTrackFile(textEditor.document.uri)) {
			console.log('onDidChangeTextEditorSelection');
			console.log(event.selections);
			// track the changed selection over here
			const selections = event.selections;
			if (selections.length !== 0) {
				await csEventHandler.onDidChangeTextDocumentSelection(textEditor.document.uri.fsPath, selections);
			}
		}
	});

	// Listen to all the files which are changing, so we can keep our tree sitter cache hot
	workspace.onDidChangeTextDocument(async (event) => {
		const documentUri = event.document.uri;
		// if its a schema type, then skip tracking it
		if (documentUri.scheme === 'vscode') {
			return;
		}
		// TODO(skcd): we want to send the file change event to the sidecar over here
		if (shouldTrackFile(documentUri)) {
			await sidecarClient.documentContentChange(
				documentUri.fsPath,
				event.contentChanges,
				event.document.getText(),
				event.document.languageId,
			);
		}
	});

	const diagnosticsListener = languages.onDidChangeDiagnostics(async (event) => {
		for (const uri of event.uris) {
			// filter out diagnostics which are ONLY errors and warnings
			const diagnostics = languages.getDiagnostics(uri).filter((diagnostic) => {
				return (diagnostic.severity === DiagnosticSeverity.Error || diagnostic.severity === DiagnosticSeverity.Warning);
			});

			// Send diagnostics to sidecar
			try {
				await sidecarClient.sendDiagnostics(uri.toString(), diagnostics);
			} catch (error) {
				// console.error(`Failed to send diagnostics for ${uri.toString()}:`, error);
			}
		}
	});

	// Register the chat agent
	const chatAgentProvider = new CSChatAgentProvider(
		rootPath, repoName, repoHash,
		uniqueUserId,
		sidecarClient, currentRepo, projectContext, probeProvider
	);
	context.subscriptions.push(chatAgentProvider);
	// register generate plan variable
	context.subscriptions.push(vscode.aideChat.registerChatVariableResolver(
		GENERATE_PLAN,
		GENERATE_PLAN,
		'Generates a plan for execution',
		'Generates a plan for execution',
		false,
		{
			resolve: (_name: string, _context: vscode.ChatVariableContext, _token: vscode.CancellationToken) => {
				return [{
					level: vscode.ChatVariableLevel.Full,
					value: 'generatePlan',
				}];
			}
		},
		'Open files',
		vscode.ThemeIcon.Folder
	));
	context.subscriptions.push(vscode.aideChat.registerChatVariableResolver(
		'EXECUTE_UNTIL',
		'EXECUTE_UNTIL',
		'Executes the plan until a checkpoint, follow your #EXECUTE_UNTIL with a number so the input should look like: #EXECUTE_UNTIL {number}',
		'Executes the plan until a checkpoint, follow your #EXECUTE_UNTIL with a number so the input should look like: #EXECUTE_UNTIL {number}',
		false,
		{
			resolve: (_name: string, _context: vscode.ChatVariableContext, _token: vscode.CancellationToken) => {
				return [{
					level: vscode.ChatVariableLevel.Full,
					value: 'executeUntil',
				}];
			}
		},
		'Execute the plan until a step',
		vscode.ThemeIcon.Folder,
	));
	context.subscriptions.push(vscode.aideChat.registerChatVariableResolver(
		'APPEND_TO_PLAN',
		'APPEND_TO_PLAN',
		'Append the user context to the plan',
		'Append the user context to the plan',
		false,
		{
			resolve: (_name: string, _context: vscode.ChatVariableContext, _token: vscode.CancellationToken) => {
				return [{
					level: vscode.ChatVariableLevel.Full,
					value: 'executeUntil',
				}];
			}
		},
		'Append a step to the plan',
		vscode.ThemeIcon.Folder,
	));
	// generate open file variable
	context.subscriptions.push(vscode.aideChat.registerChatVariableResolver(
		OPEN_FILES_VARIABLE,
		OPEN_FILES_VARIABLE,
		'Open files in the workspace',
		'Open files in the workspace',
		false,
		{
			resolve: (_name: string, _context: vscode.ChatVariableContext, _token: vscode.CancellationToken) => {
				// const openFiles = vscode.workspace.textDocuments;
				const openFiles = vscode.window.visibleTextEditors;
				console.log(openFiles);
				console.log('openFiles length');
				console.log(openFiles.length);
				const response = openFiles
					.filter(file => file.document.uri.scheme === 'file')
					.map(file => {
						const objVal = {
							uri: file.document.uri,
							range: {
								startLineNumber: 1,
								startColumn: 1,
								endLineNumber: file.document.lineCount,
								endColumn: 1,
							}
						};
						return {
							level: vscode.ChatVariableLevel.Full,
							value: JSON.stringify(objVal)
						};
					});
				return response;
			}
		},
		'Open files',
		vscode.ThemeIcon.File
	));

	// Gets access to all the events the editor is throwing our way
	const csEventHandler = new CSEventHandler(context, editorUrl);
	context.subscriptions.push(csEventHandler);

	const startRecording = commands.registerCommand(
		'codestory.startRecordingContext',
		async () => {
			await csEventHandler.startRecording();
			console.log('start recording context');
		}
	);
	context.subscriptions.push(startRecording);
	const stopRecording = commands.registerCommand(
		'codestory.stopRecordingContext',
		async () => {
			const response = await csEventHandler.stopRecording();
			await probeProvider.sendContextRecording(response);
			console.log(JSON.stringify(response));
			console.log('stop recording context');
		}
	);
	context.subscriptions.push(stopRecording);

	// records when we change to a new text document
	workspace.onDidChangeTextDocument(async (event) => {
		console.log('onDidChangeTextDocument');
		const fileName = event.document.fileName;
		await csEventHandler.onDidChangeTextDocument(fileName);
	});

	window.onDidChangeActiveTextEditor(async (editor) => {
		if (editor) {
			const activeDocument = editor.document;
			if (activeDocument) {
				const activeDocumentUri = activeDocument.uri;
				if (shouldTrackFile(activeDocumentUri)) {
					// track that changed document over here
					await csEventHandler.onDidChangeTextDocument(activeDocumentUri.fsPath);
					await sidecarClient.documentOpen(
						activeDocumentUri.fsPath,
						activeDocument.getText(),
						activeDocument.languageId
					);
				}
			}
		}
	});

	// shouldn't all listeners have this?
	context.subscriptions.push(diagnosticsListener);
}
