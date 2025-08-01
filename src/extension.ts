/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import * as vscodeMssql from "vscode-mssql";
import MainController from "./controllers/mainController";
import VscodeWrapper from "./controllers/vscodeWrapper";
import { ConnectionDetails, IConnectionInfo, IExtension } from "vscode-mssql";
import { Deferred } from "./protocol";
import * as utils from "./models/utils";
import { ObjectExplorerUtils } from "./objectExplorer/objectExplorerUtils";
import SqlToolsServerClient from "./languageservice/serviceclient";
import { ConnectionProfile } from "./models/connectionProfile";
import { FirewallRuleError } from "./languageservice/interfaces";
import { RequestType } from "vscode-languageclient";
import { createSqlAgentRequestHandler, ISqlChatResult } from "./copilot/chatAgentRequestHandler";
import { sendActionEvent } from "./telemetry/telemetry";
import { TelemetryActions, TelemetryViews } from "./sharedInterfaces/telemetry";
import { ChatResultFeedbackKind } from "vscode";

/** exported for testing purposes only */
export let controller: MainController = undefined;

export async function activate(context: vscode.ExtensionContext): Promise<IExtension> {
    let vscodeWrapper = new VscodeWrapper();
    controller = new MainController(context, undefined, vscodeWrapper);
    context.subscriptions.push(controller);

    // Checking if localization should be applied
    //let config = vscodeWrapper.getConfiguration(Constants.extensionConfigSectionName);
    //let applyLocalization = config[Constants.configApplyLocalization];
    // if (applyLocalization) {
    // 	LocalizedConstants.loadLocalizedConstants(vscode.env.language);
    // }

    // Check if GitHub Copilot is installed
    const copilotExtension = vscode.extensions.getExtension("GitHub.copilot");
    vscode.commands.executeCommand(
        "setContext",
        "mssql.copilot.isGHCInstalled",
        !!copilotExtension,
    );

    // Exposed for testing purposes
    vscode.commands.registerCommand("mssql.getControllerForTests", () => controller);
    await controller.activate();
    const participant = vscode.chat.createChatParticipant(
        "mssql.agent",
        createSqlAgentRequestHandler(controller.copilotService, vscodeWrapper, context, controller),
    );
    participant.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "images",
        "mssql-chat-avatar.jpg",
    );

    const receiveFeedbackDisposable = participant.onDidReceiveFeedback(
        (feedback: vscode.ChatResultFeedback) => {
            sendActionEvent(TelemetryViews.MssqlCopilot, TelemetryActions.Feedback, {
                kind: feedback.kind === ChatResultFeedbackKind.Helpful ? "Helpful" : "Unhelpful",
                correlationId: (feedback.result as ISqlChatResult).metadata.correlationId,
            });
        },
    );

    context.subscriptions.push(controller, participant, receiveFeedbackDisposable);

    return {
        sqlToolsServicePath: SqlToolsServerClient.instance.sqlToolsServicePath,
        promptForConnection: async (ignoreFocusOut?: boolean) => {
            const connectionProfileList =
                await controller.connectionManager.connectionStore.getPickListItems();
            return controller.connectionManager.connectionUI.promptForConnection(
                connectionProfileList,
                ignoreFocusOut,
            );
        },
        connect: async (connectionInfo: IConnectionInfo, saveConnection?: boolean) => {
            const uri = utils.generateQueryUri().toString();
            const connectionPromise = new Deferred<boolean>();
            // First wait for initial connection request to succeed
            const requestSucceeded = await controller.connect(
                uri,
                connectionInfo,
                connectionPromise,
                saveConnection,
            );
            if (!requestSucceeded) {
                if (controller.connectionManager.failedUriToFirewallIpMap.has(uri)) {
                    throw new FirewallRuleError(
                        uri,
                        `Connection request for ${JSON.stringify(connectionInfo)} failed because of invalid firewall rule settings`,
                    );
                } else {
                    throw new Error(
                        `Connection request for ${JSON.stringify(connectionInfo)} failed`,
                    );
                }
            }
            // Next wait for the actual connection to be made
            const connectionSucceeded = await connectionPromise;
            if (!connectionSucceeded) {
                throw new Error(`Connection for ${JSON.stringify(connectionInfo)} failed`);
            }
            return uri;
        },
        listDatabases: (connectionUri: string) => {
            return controller.connectionManager.listDatabases(connectionUri);
        },
        getDatabaseNameFromTreeNode: (node: vscodeMssql.ITreeNodeInfo) => {
            return ObjectExplorerUtils.getDatabaseName(node);
        },
        dacFx: controller.dacFxService,
        schemaCompare: controller.schemaCompareService,
        sqlProjects: controller.sqlProjectsService,
        getConnectionString: (
            connectionUriOrDetails: string | ConnectionDetails,
            includePassword?: boolean,
            includeApplicationName?: boolean,
        ) => {
            return controller.connectionManager.getConnectionString(
                connectionUriOrDetails,
                includePassword,
                includeApplicationName,
            );
        },
        promptForFirewallRule: (connectionUri: string, connectionInfo: IConnectionInfo) => {
            const connectionProfile = new ConnectionProfile(connectionInfo);
            return controller.connectionManager.connectionUI.addFirewallRule(
                connectionUri,
                connectionProfile,
            );
        },
        azureAccountService: controller.azureAccountService,
        azureResourceService: controller.azureResourceService,
        createConnectionDetails: (connectionInfo: IConnectionInfo) => {
            return controller.connectionManager.createConnectionDetails(connectionInfo);
        },
        sendRequest: async <P, R, E, R0>(requestType: RequestType<P, R, E, R0>, params?: P) => {
            return await controller.connectionManager.sendRequest(requestType, params);
        },
        getServerInfo: (connectionInfo: IConnectionInfo) => {
            return controller.connectionManager.getServerInfo(connectionInfo);
        },
        connectionSharing: <vscodeMssql.IConnectionSharingService>{
            getActiveEditorConnectionId: (extensionId: string) => {
                return controller.connectionSharingService.getActiveEditorConnectionId(extensionId);
            },
            connect: async (extensionId: string, connectionId: string): Promise<string> => {
                return controller.connectionSharingService.connect(extensionId, connectionId);
            },
            disconnect: (connectionUri: string): void => {
                return controller.connectionSharingService.disconnect(connectionUri);
            },
            isConnected: (connectionUri: string): boolean => {
                return controller.connectionSharingService.isConnected(connectionUri);
            },
            executeSimpleQuery: (
                connectionUri: string,
                queryString: string,
            ): Promise<vscodeMssql.SimpleExecuteResult> => {
                return controller.connectionSharingService.executeSimpleQuery(
                    connectionUri,
                    queryString,
                );
            },
            getServerInfo: (connectionUri: string): vscodeMssql.IServerInfo => {
                return controller.connectionSharingService.getServerInfo(connectionUri);
            },
            listDatabases: (connectionUri: string): Promise<string[]> => {
                return controller.connectionSharingService.listDatabases(connectionUri);
            },
            scriptObject: (connectionUri, operation, scriptingObject) => {
                return controller.connectionSharingService.scriptObject(
                    connectionUri,
                    operation,
                    scriptingObject,
                );
            },
        },
    };
}

// this method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
    if (controller) {
        await controller.deactivate();
        controller.dispose();
    }
}

/**
 * Exposed for testing purposes
 */
export async function getController(): Promise<MainController> {
    if (!controller) {
        let savedController: MainController = await vscode.commands.executeCommand(
            "mssql.getControllerForTests",
        );
        return savedController;
    }
    return controller;
}
