/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { IMarkdownString } from 'vs/base/common/htmlContent';
import { Disposable } from 'vs/base/common/lifecycle';
import { equals } from 'vs/base/common/objects';
import { generateUuid } from 'vs/base/common/uuid';

import { IAideProbeBreakdownContent, IAideProbeGoToDefinition, IAideProbeProgress, IAideProbeTextEdit, IAideProbeTextEditPreview } from 'vs/workbench/contrib/aideProbe/common/aideProbeService';

export interface IAideProbeRequestModel {
	readonly sessionId: string;
	readonly message: string;
	readonly editMode: boolean;
}

export interface IAideProbeResponseModel {
	result?: IMarkdownString;
	readonly breakdowns: ReadonlyArray<IAideProbeBreakdownContent>;
	readonly goToDefinitions: ReadonlyArray<IAideProbeGoToDefinition>;
	readonly codeEditsPreview: ReadonlyArray<IAideProbeTextEditPreview>;
	readonly codeEdits: ReadonlyArray<IAideProbeTextEdit>;
}

export interface IAideProbeModel {
	onDidChange: Event<void>;
	onDidChangeTailing: Event<boolean>;

	sessionId: string;
	request: IAideProbeRequestModel | undefined;
	response: IAideProbeResponseModel | undefined;

	isComplete: boolean;
	isTailing: boolean;
	requestInProgress: boolean;
}

export class AideProbeRequestModel extends Disposable implements IAideProbeRequestModel {
	constructor(
		readonly sessionId: string,
		readonly message: string,
		readonly editMode: boolean
	) {
		super();
	}
}

export class AideProbeResponseModel extends Disposable implements IAideProbeResponseModel {
	private _result: IMarkdownString | undefined;
	get result(): IMarkdownString | undefined {
		return this._result;
	}

	set result(value: IMarkdownString) {
		this._result = value;
	}

	private readonly _breakdownsBySymbol: Map<string, IAideProbeBreakdownContent> = new Map();
	private readonly _breakdowns: IAideProbeBreakdownContent[] = [];

	public get breakdowns(): ReadonlyArray<IAideProbeBreakdownContent> {
		return this._breakdowns;
	}

	private readonly _goToDefinitions: IAideProbeGoToDefinition[] = [];
	public get goToDefinitions(): ReadonlyArray<IAideProbeGoToDefinition> {
		return this._goToDefinitions;
	}

	private readonly _codeEditsPreviewBySymbol: Map<string, IAideProbeTextEditPreview[]> = new Map();
	private readonly _codeEditsPreview: IAideProbeTextEditPreview[] = [];
	public get codeEditsPreview(): ReadonlyArray<IAideProbeTextEditPreview> {
		return this._codeEditsPreview;
	}

	private readonly _codeEdits: IAideProbeTextEdit[] = [];
	public get codeEdits(): ReadonlyArray<IAideProbeTextEdit> {
		return this._codeEdits;
	}

	constructor() {
		super();
	}

	/**
	 * Apply a breakdown to the response content.
	*/
	applyBreakdown(breakdown: IAideProbeBreakdownContent) {
		const mapKey = `${breakdown.reference.uri.toString()}:${breakdown.reference.name}`;
		const { query, reason, response } = breakdown;
		if (this._breakdownsBySymbol.has(mapKey)) {
			if (query && query.value.length > 0) {
				this._breakdownsBySymbol.get(mapKey)!.query = query;
			}
			if (reason && reason.value.length > 0) {
				this._breakdownsBySymbol.get(mapKey)!.reason = reason;
			}
			if (response && response.value.length > 0) {
				this._breakdownsBySymbol.get(mapKey)!.response = response;
			}
			// Update the breakdown in the list
			const index = this._breakdowns.findIndex(
				b => equals(b.reference.name, breakdown.reference.name) && equals(b.reference.uri, breakdown.reference.uri)
			);
			if (index !== -1) {
				this._breakdowns[index] = this._breakdownsBySymbol.get(mapKey)!;
			}
		} else {
			this._breakdownsBySymbol.set(mapKey, breakdown);
			this._breakdowns.push(breakdown);
		}
	}

	/**
	 * Decorate a go to definition in the response content.
	*/
	applyGoToDefinition(goToDefinition: IAideProbeGoToDefinition) {
		const existing = this._goToDefinitions.find(gtd => equals(gtd.uri, goToDefinition.uri) && equals(gtd.name, goToDefinition.name));
		if (existing) {
			return;
		}

		this._goToDefinitions.push(goToDefinition);
	}

	/**
		* Decorate a chunk of code to be edited in the response content.
	*/
	applyCodeEditPreview(codeEditPreview: IAideProbeTextEditPreview) {
		const mapKey = `${codeEditPreview.reference.uri.toString()}:${codeEditPreview.reference.name}`;
		if (this._codeEditsPreviewBySymbol.has(mapKey)) {
			this._codeEditsPreviewBySymbol.get(mapKey)!.push(codeEditPreview);
		} else {
			this._codeEditsPreviewBySymbol.set(mapKey, [codeEditPreview]);
			this._codeEditsPreview.push(codeEditPreview);
		}
	}

	/**
	 * Decorate a chunk of code to be edited in the response content.
	*/
	applyCodeEdit(codeEdit: IAideProbeTextEdit) {
		const mapKey = `${codeEdit.reference.uri.toString()}:${codeEdit.reference.name}`;
		if (this._codeEditsPreviewBySymbol.has(mapKey)) {
			this._codeEditsPreviewBySymbol.delete(mapKey);
		}
		this._codeEdits.push(codeEdit);
	}
}

export class AideProbeModel extends Disposable implements IAideProbeModel {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidChangeTailing = this._register(new Emitter<boolean>());
	readonly onDidChangeTailing = this._onDidChangeTailing.event;

	private _request: AideProbeRequestModel | undefined;
	private _response: AideProbeResponseModel | undefined;
	private _isComplete = false;
	private _isTailing = false;

	private _sessionId: string;
	get sessionId(): string {
		return this._sessionId;
	}

	get request(): IAideProbeRequestModel | undefined {
		return this._request;
	}

	get requestInProgress(): boolean {
		return !!this._request && !this._isComplete;
	}

	set request(value: AideProbeRequestModel) {
		this._request = value;
	}

	get response(): AideProbeResponseModel | undefined {
		return this._response;
	}

	get isComplete(): boolean {
		return this._isComplete;
	}

	get isTailing(): boolean {
		return this._isTailing;
	}

	constructor() {
		super();

		this._sessionId = generateUuid();
	}

	acceptResponseProgress(progress: IAideProbeProgress): void {
		if (!this._request) {
			throw new Error('Request not yet initialised');
		}

		if (!this._response) {
			this._response = new AideProbeResponseModel();
		}


		switch (progress.kind) {
			case 'markdownContent':
				this._response.result = progress.content;
				break;
			case 'breakdown':
				this._response.applyBreakdown(progress);
				break;
			case 'goToDefinition':
				this._response.applyGoToDefinition(progress);
				break;
			case 'textEditPreview':
				this._response.applyCodeEditPreview(progress);
				break;
			case 'textEdit':
				this._response.applyCodeEdit(progress);
				break;
		}

		this._onDidChange.fire();
	}

	completeResponse(): void {
		this._isComplete = true;
		this.followAlong(false);

		this._onDidChange.fire();
	}

	cancelRequest(): void {
		this._request = undefined;
		this._response = undefined;
		this._isComplete = false;

		this._onDidChange.fire();
	}

	followAlong(follow: boolean): void {
		this._isTailing = follow;

		this._onDidChangeTailing.fire(follow);
	}
}
