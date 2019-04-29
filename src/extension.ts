'use strict';
import * as vscode from 'vscode';
import ZigCompilerProvider from './zigCompilerProvider';
import { ZigFormatProvider, ZigRangeFormatProvider } from './zigFormat';

const ZIG_MODE: vscode.DocumentFilter = { language: 'zig', scheme: 'file' };

export function activate(context: vscode.ExtensionContext) {
    let compiler = new ZigCompilerProvider();
    compiler.activate(context.subscriptions);
    vscode.languages.registerCodeActionsProvider('zig', compiler);

    const zigFormatStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
    );
    const logChannel = vscode.window.createOutputChannel('zig');
    context.subscriptions.push(logChannel);
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            ZIG_MODE,
            new ZigFormatProvider(logChannel),
        ),
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider(
            ZIG_MODE,
            new ZigRangeFormatProvider(logChannel),
        ),
    );

    // TODO: enable when implemented
    // context.subscriptions.push(
    //     vscode.debug.registerDebugConfigurationProvider('zig', new ZigDebugConfigurationProvider())
    // );
}

export function deactivate() {
}


// export class ZigDebugConfigurationProvider
//     implements vscode.DebugConfigurationProvider {
//     /**
//      * Massage a debug configuration just before a debug session is being launched,
//      * e.g. add all missing attributes to the debug configuration.
//      */
//     resolveDebugConfiguration(
//         folder: WorkspaceFolder | undefined,
//         config: DebugConfiguration,
//         token?: CancellationToken,
//     ): ProviderResult<DebugConfiguration> {
//         // TODO: implement
//         return config;
//     }
// }