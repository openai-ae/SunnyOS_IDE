/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { workspace, languages, Uri, commands, env, ExtensionContext, OutputChannel, Position, window } from 'vscode';
import { CodeStoryStorage, loadOrSaveToStorage } from './storage/types';
import { indexRepository } from './storage/indexer';
import { getProject, TSMorphProjectManagement } from './utilities/parseTypescript';
import logger from './logger';
import { CodeGraph, generateCodeGraph } from './codeGraph/graph';
import { EmbeddingsSearch } from './codeGraph/embeddingsSearch';
import postHogClient from './posthog/client';
import { AgentViewProvider } from './views/AgentView';
import { CodeStoryViewProvider } from './views/codeStoryView';
import { healthCheck } from './subscriptions/health';
import { openFile, search } from './subscriptions/search';
import { TrackCodeSymbolChanges } from './activeChanges/trackCodeSymbolChanges';
import { FILE_SAVE_TIME_PERIOD, TimeKeeper } from './subscriptions/timekeeper';
import { fileStateFromPreviousCommit } from './activeChanges/fileStateFromPreviousCommit';
import { CodeBlockChangeDescriptionGenerator } from './activeChanges/codeBlockChangeDescriptionGenerator';
import { triggerCodeSymbolChange } from './activeChanges/timeline';
import { gitCommit } from './subscriptions/gitCommit';
import { getGitCurrentHash, getGitRepoName } from './git/helper';
import { debug } from './subscriptions/debug';
import { copySettings } from './utilities/copySettings';

import { EventEmitter } from 'events';
import { readActiveDirectoriesConfiguration } from './utilities/activeDirectories';
import { startAidePythonBackend } from './utilities/setupAntonBackend';
import { PythonServer } from './utilities/pythonServerClient';
import { sleep } from './utilities/sleep';
import winston from 'winston';


class ProgressiveTrackSymbols {
	private emitter: EventEmitter;

	constructor() {
		this.emitter = new EventEmitter();
	}

	async onLoadFromLastCommit(
		trackCodeSymbolChanges: TrackCodeSymbolChanges,
		workingDirectory: string,
		logger: winston.Logger,
	) {
		const filesChangedFromLastCommit = await fileStateFromPreviousCommit(
			workingDirectory ?? '',
			logger,
		);

		for (const fileChanged of filesChangedFromLastCommit) {
			await trackCodeSymbolChanges.filesChangedSinceLastCommit(
				fileChanged.filePath,
				fileChanged.fileContent,
				this.emitter,
			);
		}
		trackCodeSymbolChanges.statusUpdated = true;
	}

	on(event: string, listener: (...args: any[]) => void) {
		this.emitter.on(event, listener);
	}
}


class ProgressiveGraphBuilder {
	private emitter: EventEmitter;

	constructor() {
		this.emitter = new EventEmitter();
	}

	async loadGraph(
		projectManagement: TSMorphProjectManagement,
		pythonServer: PythonServer,
		workingDirectory: string,
	) {
		await generateCodeGraph(
			projectManagement,
			pythonServer,
			workingDirectory,
			this.emitter,
		);
	}

	on(event: string, listener: (...args: any[]) => void) {
		this.emitter.on(event, listener);
	}
}

class ProgressiveIndexer {
	private emitter: EventEmitter;

	constructor() {
		this.emitter = new EventEmitter();
	}

	async indexRepository(
		storage: CodeStoryStorage,
		projectManagement: TSMorphProjectManagement,
		pythonServer: PythonServer,
		globalStorageUri: string,
		workingDirectory: string
	) {
		// Sleep for a bit before starting the heavy lifting, so other parts of the
		// extension can load up
		await sleep(1000);
		await indexRepository(
			storage,
			projectManagement,
			pythonServer,
			globalStorageUri,
			workingDirectory,
			this.emitter
		);
	}

	on(event: string, listener: (...args: any[]) => void) {
		this.emitter.on(event, listener);
	}
}

async function deferredStartup(
	context: ExtensionContext,
	rootPath: string,
	agentViewProvider: AgentViewProvider,
	csViewProvider: CodeStoryViewProvider,
) {
	const repoName = await getGitRepoName(rootPath);
	const repoHash = await getGitCurrentHash(rootPath);

	// Now we want to register the HC
	context.subscriptions.push(healthCheck(context, csViewProvider, repoName, repoHash));
	commands.executeCommand('codestory.healthCheck');

	const serverUrl = await startAidePythonBackend(
		context.globalStorageUri.fsPath,
		rootPath,
	);
	const pythonServer = new PythonServer(serverUrl);
	// Get the storage object here
	const codeStoryStorage = await loadOrSaveToStorage(context.globalStorageUri.fsPath, rootPath);
	logger.info(codeStoryStorage);
	logger.info(rootPath);
	// Ts-morph project management
	const activeDirectories = readActiveDirectoriesConfiguration(rootPath);
	logger.info(activeDirectories);
	const projectManagement = await getProject(activeDirectories);

	// Create an instance of the progressive indexer
	const indexer = new ProgressiveIndexer();
	const embeddingsIndex = new EmbeddingsSearch([]);
	indexer.on('partialData', (partialData) => {
		embeddingsIndex.updateNodes(partialData);
	});
	indexer.indexRepository(
		codeStoryStorage,
		projectManagement,
		pythonServer,
		context.globalStorageUri.fsPath,
		rootPath,
	);

	const progressiveGraphBuilder = new ProgressiveGraphBuilder();
	const codeGraph = new CodeGraph([]);
	progressiveGraphBuilder.on('partialData', (partialData) => {
		codeGraph.addNodes(partialData);
	});
	progressiveGraphBuilder.loadGraph(
		projectManagement,
		pythonServer,
		rootPath,
	);

	context.subscriptions.push(
		debug(
			// TODO(codestory): Fix this properly later on
			agentViewProvider,
			embeddingsIndex,
			projectManagement,
			pythonServer,
			codeGraph,
			repoName,
			repoHash,
			rootPath ?? ''
		)
	);

	// We register the search command
	// Semantic search
	context.subscriptions.push(
		search(csViewProvider, embeddingsIndex, repoName, repoHash),
		openFile(logger)
	);

	const trackCodeSymbolChanges = new TrackCodeSymbolChanges(
		projectManagement,
		pythonServer,
		rootPath ?? '',
		logger
	);
	logger.info('[check 6]We are over here');
	const timeKeeperFileSaved = new TimeKeeper(FILE_SAVE_TIME_PERIOD);
	const codeBlockDescriptionGenerator = new CodeBlockChangeDescriptionGenerator(logger);
	logger.info('[check 7]We are over here');
	const progressiveTrackSymbolsOnLoad = new ProgressiveTrackSymbols();
	progressiveTrackSymbolsOnLoad.on('fileChanged', (fileChangedEvent) => {
		trackCodeSymbolChanges.setFileOpenedCodeSymbolTracked(
			fileChangedEvent.filePath,
			fileChangedEvent.codeSymbols
		);
	});
	// progressiveTrackSymbolsOnLoad.onLoadFromLastCommit(
	//   trackCodeSymbolChanges,
	//   rootPath ?? '',
	//   logger,
	// );
	logger.info('[check 9]We are over here');

	// Also track the documents when they were last opened
	context.subscriptions.push(
		workspace.onDidOpenTextDocument(async (doc) => {
			const uri = doc.uri;
			await trackCodeSymbolChanges.fileOpened(uri, logger);
		})
	);

	logger.info('[check 10]We are over here');

	// Now we parse the documents on save as well
	context.subscriptions.push(
		workspace.onDidSaveTextDocument(async (doc) => {
			const uri = doc.uri;
			const fsPath = doc.uri.fsPath;
			await trackCodeSymbolChanges.fileSaved(uri, logger);
			await triggerCodeSymbolChange(
				csViewProvider,
				trackCodeSymbolChanges,
				timeKeeperFileSaved,
				fsPath,
				codeBlockDescriptionGenerator,
				logger
			);
		})
	);

	await sleep(1000);
	const documentSymbolProviders = languages.getDocumentSymbolProvider(
		'typescript'
	);
	logger.info('[document-symbol-providers golang]');
	logger.info(documentSymbolProviders);
	const uri = Uri.file('/Users/skcd/test_repo/ripgrep/crates/core/logger.rs');
	const textDocument = await workspace.openTextDocument(uri);
	for (let index = 0; index < documentSymbolProviders.length; index++) {
		logger.info('[text documents]');
		logger.info(workspace.textDocuments.map(document => document.uri.fsPath));
		if (textDocument) {
			logger.info('[textDocuments]');
			const documentSymbols = await documentSymbolProviders[index].provideDocumentSymbols(
				textDocument,
				{
					isCancellationRequested: false,
					onCancellationRequested: () => ({ dispose() { } }),
				},
			);
			logger.info('[symbolsDocument]');
			logger.info(documentSymbols?.map((symbol) => symbol.name));
		} else {
			logger.info('file not found');
		}
	}
	logger.info('[document-symbol-providers] ' + documentSymbolProviders.length);


	const providers = languages.getDefinitionProvider({
		language: 'typescript',
		scheme: 'file',
	});
	logger.info('[providers for language ss]' + providers.length);
	for (let index = 0; index < providers.length; index++) {
		logger.info('asking for definitions');
		try {
			const definitions = await providers[index].provideDefinition(
				textDocument,
				new Position(37, 29),
				{
					isCancellationRequested: false,
					onCancellationRequested: () => ({ dispose() { } }),
				}
			);
			logger.info('[definitions sss]');
			logger.info(definitions);
		} catch (e) {
			logger.info(e);
		}
	}

	const referencesProviders = languages.getReferenceProvider({
		language: 'typescript',
		scheme: 'file',
	});
	logger.info('[references for language ss]' + referencesProviders.length);
	for (let index = 0; index < referencesProviders.length; index++) {
		try {
			logger.info('asking for references');
			const references = await referencesProviders[index].provideReferences(
				textDocument,
				new Position(25, 16),
				{
					includeDeclaration: true,
				},
				{
					isCancellationRequested: false,
					onCancellationRequested: () => ({ dispose() { } }),
				}
			);
			logger.info('[references sss]');
			logger.info(references);
		} catch (e) {
			logger.info(e);
		}
	}

	// Add git commit to the subscriptions here
	// Git commit
	context.subscriptions.push(gitCommit(logger, repoName, repoHash));
}

export async function activate(context: ExtensionContext) {
	// Project root here
	postHogClient.capture({
		distinctId: env.machineId,
		event: 'extension_activated',
	});
	let rootPath = workspace.rootPath;
	if (!rootPath) {
		rootPath = '';
	}
	if (rootPath === '') {
		window.showErrorMessage('Please open a folder in VS Code to use CodeStory');
		return;
	}

	// Create the copy settings from vscode command for the extension
	const registerCopySettingsCommand = commands.registerCommand(
		'webview.copySettings',
		async () => {
			await copySettings(rootPath ?? '', logger);
		}
	);
	context.subscriptions.push(registerCopySettingsCommand);

	// Register the agent view provider
	const agentViewProvider = new AgentViewProvider(context.extensionUri);
	context.subscriptions.push(
		window.registerWebviewViewProvider(AgentViewProvider.viewType, agentViewProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// Register the codestory view provider
	const csViewProvider = new CodeStoryViewProvider(context.extensionUri, new Date());
	context.subscriptions.push(
		window.registerWebviewViewProvider(CodeStoryViewProvider.viewType, csViewProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	deferredStartup(context, rootPath, agentViewProvider, csViewProvider);
}
