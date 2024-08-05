/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { authentication, AuthenticationProvider, AuthenticationProviderAuthenticationSessionsChangeEvent, AuthenticationSession, Disposable, env, Event, EventEmitter, ExtensionContext, ProgressLocation, Uri, UriHandler, window } from 'vscode';

const AUTH_TYPE = 'codestory';
const AUTH_NAME = 'CodeStory';
const SESSIONS_SECRET_KEY = `${AUTH_TYPE}.sessions`;

class UriEventHandler extends EventEmitter<Uri> implements UriHandler {
	public handleUri(uri: Uri) {
		this.fire(uri);
	}
}

interface CodeStoryAuthenticationSession extends AuthenticationSession {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

type User = {
	id: string;
	first_name: string;
	last_name: string;
	email: string;
	created_at: string;
	updated_at: string;
	email_verified: boolean;
	profile_picture_url: string;
};

type EncodedTokenData = {
	access_token: string;
	refresh_token: string;
};

type UserProfileResponse = {
	user: User;
};

export class CodeStoryAuthProvider implements AuthenticationProvider, Disposable {
	private readonly _sessionChangeEmitter = new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._sessionChangeEmitter.event;

	get redirectUri() {
		const publisher = this.context.extension.packageJSON.publisher;
		const name = this.context.extension.packageJSON.name;
		return `${env.uriScheme}://${publisher}.${name}`;
	}

	private readonly _disposable: Disposable;
	private _pendingStates: string[] = [];
	private _loginPromises = new Map<
		string,
		{ promise: Promise<string>; cancel: EventEmitter<void> }
	>();
	private _uriHandler = new UriEventHandler();
	private static EXPIRATION_TIME_MS = 1000 * 60 * 5; // 5 minutes

	constructor(
		private readonly context: ExtensionContext
	) {
		this._disposable = Disposable.from(
			authentication.registerAuthenticationProvider(AUTH_TYPE, AUTH_NAME, this, { supportsMultipleAccounts: false }),
			window.registerUriHandler(this._uriHandler)
		);
	}

	async getSessions(): Promise<readonly CodeStoryAuthenticationSession[]> {
		const allSessions = await this.context.secrets.get(SESSIONS_SECRET_KEY);

		if (allSessions) {
			return JSON.parse(allSessions) as CodeStoryAuthenticationSession[];
		}

		return [];
	}

	async createSession(scopes: readonly string[]): Promise<CodeStoryAuthenticationSession> {
		try {
			const encodedTokenData = await this.login(scopes);
			if (!encodedTokenData) {
				throw new Error(`CodeStory login failure`);
			}

			const userInfo = (await this.getUserInfo(encodedTokenData));
			const { user, access_token, refresh_token } = userInfo;

			const session: CodeStoryAuthenticationSession = {
				id: uuidv4(),
				accessToken: access_token,
				refreshToken: refresh_token,
				expiresIn: CodeStoryAuthProvider.EXPIRATION_TIME_MS,
				account: {
					label: user.first_name + ' ' + user.last_name,
					id: user.email,
				},
				scopes: [],
			};

			await this.context.secrets.store(
				SESSIONS_SECRET_KEY,
				JSON.stringify([session]),
			);

			this._sessionChangeEmitter.fire({
				added: [session],
				removed: [],
				changed: [],
			});

			return session;
		} catch (e) {
			window.showErrorMessage(`Sign in failed: ${e}`);
			throw e;
		}
	}

	async removeSession(sessionId: string): Promise<void> {
		const allSessions = await this.context.secrets.get(SESSIONS_SECRET_KEY);
		if (allSessions) {
			const sessions = JSON.parse(allSessions) as CodeStoryAuthenticationSession[];
			const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
			const session = sessions[sessionIdx];
			sessions.splice(sessionIdx, 1);

			await this.context.secrets.store(
				SESSIONS_SECRET_KEY,
				JSON.stringify(sessions),
			);

			if (session) {
				this._sessionChangeEmitter.fire({
					added: [],
					removed: [session],
					changed: [],
				});
			}
		}
	}

	dispose() {
		this._disposable.dispose();
	}

	/**
	 * Log in to CodeStory via AuthKit
	 **/
	private async login(scopes: readonly string[] = []) {
		return await window.withProgress<string>(
			{
				location: ProgressLocation.Notification,
				title: 'Signing in to CodeStory...',
				cancellable: true,
			},
			async (_, token) => {
				const stateId = uuidv4();
				this._pendingStates.push(stateId);

				const url = `http://localhost:3000/authenticate?state=${stateId}`;
				await env.openExternal(Uri.parse(url));

				let loginPromise = this._loginPromises.get(stateId);
				if (!loginPromise) {
					loginPromise = promiseFromEvent(
						this._uriHandler.event,
						this.handleUri(scopes),
					);
					this._loginPromises.set(stateId, loginPromise);
				}

				try {
					return await Promise.race([
						loginPromise.promise,
						new Promise<string>((_, reject) =>
							setTimeout(() => reject('Cancelled'), 60000),
						),
						promiseFromEvent<any, any>(
							token.onCancellationRequested,
							(_, __, reject) => {
								reject('User Cancelled');
							},
						).promise,
					]);
				} finally {
					this._pendingStates = this._pendingStates.filter(
						(n) => n !== stateId,
					);
					loginPromise?.cancel.fire();
					this._loginPromises.delete(stateId);
				}
			},
		);
	}

	/**
	 * Handle the redirect to Aide (after sign in from CodeStory)
	 * @param scopes
	 * @returns
	 **/
	private handleUri: (
		scopes: readonly string[]
	) => PromiseAdapter<Uri, string> = () => async (uri, resolve, reject) => {
		const query = new URLSearchParams(uri.query);
		const encodedData = query.get('data');
		if (!encodedData) {
			reject(new Error('No token'));
			return;
		}

		resolve(encodedData);
	};

	/**
	 * Get the user info from WorkOS
	 * @param encodedTokenData
	 * @returns
	 **/
	private async getUserInfo(encodedTokenData: string) {
		// Reverse the base64 encoding
		const tokenData = Buffer.from(encodedTokenData, 'base64').toString('utf-8');
		const tokens = JSON.parse(tokenData) as EncodedTokenData;

		const resp = await fetch(
			'http://localhost:3333/v1/users/me',
			{
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${tokens.access_token}`,
				},
			},
		);
		const text = await resp.text();
		const data = JSON.parse(text) as UserProfileResponse;
		return { ...data, ...tokens };
	}
}

interface PromiseAdapter<T, U> {
	(
		value: T,
		resolve: (value: U | PromiseLike<U>) => void,
		reject: (reason: any) => void,
	): any;
}

const passthrough = (value: any, resolve: (value?: any) => void) =>
	resolve(value);

/**
 * Return a promise that resolves with the next emitted event, or with some future
 * event as decided by an adapter.
 *
 * If specified, the adapter is a function that will be called with
 * `(event, resolve, reject)`. It will be called once per event until it resolves or
 * rejects.
 *
 * The default adapter is the passthrough function `(value, resolve) => resolve(value)`.
 *
 * @param event the event
 * @param adapter controls resolution of the returned promise
 * @returns a promise that resolves or rejects as specified by the adapter
 */
function promiseFromEvent<T, U>(
	event: Event<T>,
	adapter: PromiseAdapter<T, U> = passthrough,
): { promise: Promise<U>; cancel: EventEmitter<void> } {
	let subscription: Disposable;
	const cancel = new EventEmitter<void>();

	return {
		promise: new Promise<U>((resolve, reject) => {
			cancel.event((_) => reject('Cancelled'));
			subscription = event((value: T) => {
				try {
					Promise.resolve(adapter(value, resolve, reject)).catch(reject);
				} catch (error) {
					reject(error);
				}
			});
		}).then(
			(result: U) => {
				subscription.dispose();
				return result;
			},
			(error) => {
				subscription.dispose();
				throw error;
			},
		),
		cancel,
	};
}
