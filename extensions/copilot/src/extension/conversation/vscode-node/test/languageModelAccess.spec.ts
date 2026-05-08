/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OutputMode } from '@vscode/prompt-tsx';
import { beforeEach, describe, it } from 'vitest';
import * as vscode from 'vscode';
import { IChatMLFetcher } from '../../../../platform/chat/common/chatMLFetcher';
import { MockChatMLFetcher } from '../../../../platform/chat/test/common/mockChatMLFetcher';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { ITokenizerProvider } from '../../../../platform/tokenizer/node/tokenizer';
import { ITokenizer as IUtilTokenizer } from '../../../../util/common/tokenizer';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionTestingServices } from '../../../test/vscode-node/services';
import { CopilotLanguageModelWrapper } from '../languageModelAccess';
import { ExtensionContributedChatEndpoint } from '../../../../platform/endpoint/vscode-node/extChatEndpoint';

const testExtensionId = 'github.copilot.test';

function ensureMockExtensionsApi(): void {
	Object.defineProperty(vscode, 'extensions', {
		configurable: true,
		value: {
			all: [{ id: testExtensionId }],
			getExtension: (id: string) => id === testExtensionId ? { packageJSON: { version: '1.0.0-test' } } : undefined,
		}
	});
}

function createMockTokenizer(): IUtilTokenizer {
	return {
		mode: OutputMode.Raw,
		tokenLength: async () => 0,
		countMessageTokens: async () => 0,
		countMessagesTokens: async () => 0,
		countToolTokens: async () => 0,
	};
}

class MockExtensionContributedLanguageModel implements Partial<vscode.LanguageModelChat> {
	public readonly vendor = 'mock-vendor';
	public readonly id = 'mock-id';
	public readonly name = 'Mock Model';
	public readonly version = '1.0.0';
	public readonly family = 'mock-family';
	public readonly maxInputTokens = 4096;
	public readonly capabilities = {
		supportsToolCalling: false,
		supportsImageToText: false,
		editToolsHint: [],
	};

	countTokens(_input: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2): Thenable<number> {
		return Promise.resolve(1);
	}

	sendRequest(
		_messages: Parameters<vscode.LanguageModelChat['sendRequest']>[0],
		_options: Parameters<vscode.LanguageModelChat['sendRequest']>[1],
		_token: Parameters<vscode.LanguageModelChat['sendRequest']>[2],
	): ReturnType<vscode.LanguageModelChat['sendRequest']> {
		const stream = (async function* (): AsyncIterable<vscode.LanguageModelTextPart> {
			yield new vscode.LanguageModelTextPart('ok');
		})();
		return Promise.resolve({ stream } as Awaited<ReturnType<vscode.LanguageModelChat['sendRequest']>>);
	}
}


describe('CopilotLanguageModelWrapper', () => {
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;

	function createAccessor(vscodeExtensionContext?: IVSCodeExtensionContext) {
		ensureMockExtensionsApi();
		const testingServiceCollection = createExtensionTestingServices();
		testingServiceCollection.define(IChatMLFetcher, new MockChatMLFetcher());
		testingServiceCollection.define(ITokenizerProvider, {
			_serviceBrand: undefined,
			acquireTokenizer: () => createMockTokenizer(),
		} satisfies ITokenizerProvider);

		accessor = testingServiceCollection.createTestingAccessor();
		instaService = accessor.get(IInstantiationService);
	}

	describe('validateRequest - invalid', () => {
		let wrapper: CopilotLanguageModelWrapper;
		let endpoint: IChatEndpoint;
		beforeEach(async () => {
			createAccessor();
			endpoint = await accessor.get(IEndpointProvider).getChatEndpoint('copilot-base');
			wrapper = instaService.createInstance(CopilotLanguageModelWrapper);
		});

		const runTest = async (messages: vscode.LanguageModelChatMessage[], tools?: vscode.LanguageModelChatTool[], errMsg?: string) => {
			await assert.rejects(
				() => wrapper.provideLanguageModelResponse(endpoint, messages, { tools, requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto }, testExtensionId, { report: () => { } }, CancellationToken.None),
				err => {
					errMsg ??= 'Invalid request';
					assert.ok(err instanceof Error, 'expected an Error');
					assert.ok(err.message.includes(errMsg), `expected error to include "${errMsg}", got ${err.message}`);
					return true;
				}
			);
		};

		it('empty', async () => {
			await runTest([]);
		});

		it('bad tool name', async () => {
			await runTest([vscode.LanguageModelChatMessage.User('hello')], [{ name: 'hello world', description: 'my tool' }], 'Invalid tool name');
		});
	});

	describe('validateRequest - valid', () => {
		let wrapper: CopilotLanguageModelWrapper;
		let endpoint: IChatEndpoint;
		beforeEach(async () => {
			createAccessor();
			endpoint = await accessor.get(IEndpointProvider).getChatEndpoint('copilot-base');
			wrapper = instaService.createInstance(CopilotLanguageModelWrapper);
		});
		const runTest = async (messages: vscode.LanguageModelChatMessage[], tools?: vscode.LanguageModelChatTool[]) => {
			await wrapper.provideLanguageModelResponse(endpoint, messages, { tools, requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto }, testExtensionId, { report: () => { } }, CancellationToken.None);
		};

		it('simple', async () => {
			await runTest([vscode.LanguageModelChatMessage.User('hello')]);
		});

		it('tool call and user message', async () => {
			const toolCall = vscode.LanguageModelChatMessage.Assistant('');
			toolCall.content = [new vscode.LanguageModelToolCallPart('id', 'func', { param: 123 })];
			const toolResult = vscode.LanguageModelChatMessage.User('');
			toolResult.content = [new vscode.LanguageModelToolResultPart('id', [new vscode.LanguageModelTextPart('result')])];
			await runTest([toolCall, toolResult, vscode.LanguageModelChatMessage.User('user message')]);
		});

		it('good tool name', async () => {
			await runTest([vscode.LanguageModelChatMessage.User('hello2')], [{ name: 'hello_world', description: 'my tool' }]);
		});

		it('class-based extension endpoint does not regress when cloning prompt token limit', async () => {
			const extensionModel = new MockExtensionContributedLanguageModel() as vscode.LanguageModelChat;
			const extensionEndpoint = instaService.createInstance(ExtensionContributedChatEndpoint, extensionModel, undefined);

			await wrapper.provideLanguageModelResponse(
				extensionEndpoint,
				[vscode.LanguageModelChatMessage.User('hello')],
				{ requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto },
				testExtensionId,
				{ report: () => { } },
				CancellationToken.None,
			);
		});
	});
});
