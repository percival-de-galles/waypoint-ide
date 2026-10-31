/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { IJsonRpcProtocolHandlers, JsonRpcMessage, JsonRpcProtocol } from '../../../../base/common/jsonRpcProtocol.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

/**
 * A running Agent Client Protocol agent: JSON-RPC 2.0 as newline-delimited JSON on
 * the agent's stdio. The agent is the user's own CLI (`agent acp`, `opencode acp`),
 * so it reads its own configuration and sign-in.
 */
export class AcpConnection extends Disposable {

	private readonly _child: ChildProcessWithoutNullStreams;
	private readonly _protocol: JsonRpcProtocol;
	private _exited = false;

	private readonly _onDidExit = this._register(new Emitter<void>());
	readonly onDidExit = this._onDidExit.event;

	constructor(command: string, args: readonly string[], handlers: IJsonRpcProtocolHandlers, private readonly _log: (message: string) => void) {
		super();
		this._child = spawn(command, args, { env: agentProcessEnv(process.env), stdio: 'pipe' });
		this._protocol = this._register(new JsonRpcProtocol(message => this._write(message), handlers));

		let buffer = '';
		this._child.stdout.setEncoding('utf8');
		this._child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					this._receive(line);
				}
			}
		});
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', (chunk: string) => this._log(`stderr: ${chunk.trimEnd()}`));
		this._child.stdin.on('error', error => this._log(`stdin: ${error.message}`));
		this._child.on('error', error => {
			this._log(`failed to run ${command}: ${error.message}`);
			this._exit();
		});
		this._child.on('exit', () => this._exit());
	}

	get exited(): boolean {
		return this._exited;
	}

	request<T>(method: string, params: unknown, token: CancellationToken = CancellationToken.None): Promise<T> {
		return this._protocol.sendRequest<T>({ method, params }, token);
	}

	notify(method: string, params: unknown): void {
		this._protocol.sendNotification({ method, params });
	}

	private _receive(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line);
		} catch {
			this._log(`ignored a line that is not JSON: ${line.slice(0, 200)}`);
			return;
		}
		// The protocol sends any reply itself through `_write`.
		void this._protocol.handleMessage(message);
	}

	private _write(message: JsonRpcMessage): void {
		if (!this._exited) {
			this._child.stdin.write(JSON.stringify(message) + '\n');
		}
	}

	private _exit(): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		this._protocol.cancelAllRequests();
		this._onDidExit.fire();
	}

	override dispose(): void {
		this._exit();
		this._child.kill();
		super.dispose();
	}
}

/** The agent's environment: the user's, without the variables that make a child behave like part of VS Code. */
export function agentProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('VSCODE_') && !key.startsWith('ELECTRON_')));
}
