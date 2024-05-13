/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SidecarGoToImplementationRequest, SidecarGoToImplementationResponse } from './types';
import { shouldTrackFile } from '../utilities/openTabs';


export async function goToImplementation(request: SidecarGoToImplementationRequest): Promise<SidecarGoToImplementationResponse> {
	const locations: vscode.LocationLink[] = await vscode.commands.executeCommand(
		'vscode.executeImplementationProvider',
		request.fs_file_path,
		request.position,
	);
	const implementations = await Promise.all(locations.map(async (location) => {
		const uri = location.targetUri;
		const range = location.targetRange;
		if (shouldTrackFile(uri)) {
			console.log('we are trakcing this uri');
			console.log(uri);
		}
		return {
			fs_file_path: uri.fsPath,
			range: {
				startPosition: {
					line: range.start.line,
					character: range.start.character,
				},
				endPosition: {
					line: range.end.line,
					character: range.end.character,
				},
			}
		};
	}));
	return {
		implementation_locations: implementations,
	};
}