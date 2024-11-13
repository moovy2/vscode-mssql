/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import VscodeWrapper from "../controllers/vscodeWrapper";
import * as Constants from "../constants/constants";
import * as vscode from "vscode";
import {
    TelemetryViews,
    TelemetryActions,
} from "../sharedInterfaces/telemetry";
import { ApiStatus } from "../sharedInterfaces/webview";
import {
    createExecutionPlanGraphs,
    saveExecutionPlan,
    showPlanXml,
    showQuery,
    updateTotalCost,
} from "../controllers/sharedExecutionPlanUtils";
import { sendActionEvent } from "../telemetry/telemetry";
import * as qr from "../sharedInterfaces/queryResult";
import { QueryResultWebviewPanelController } from "./queryResultWebviewPanelController";
import { QueryResultWebviewController } from "./queryResultWebViewController";

export function getNewResultPaneViewColumn(
    uri: string,
    vscodeWrapper: VscodeWrapper,
): vscode.ViewColumn {
    // // Find configuration options
    let config = vscodeWrapper.getConfiguration(
        Constants.extensionConfigSectionName,
        uri,
    );
    let splitPaneSelection = config[Constants.configSplitPaneSelection];
    let viewColumn: vscode.ViewColumn;

    switch (splitPaneSelection) {
        case "current":
            viewColumn = vscodeWrapper.activeTextEditor.viewColumn;
            break;
        case "end":
            viewColumn = vscode.ViewColumn.Three;
            break;
        // default case where splitPaneSelection is next or anything else
        default:
            // if there's an active text editor
            if (vscodeWrapper.isEditingSqlFile) {
                viewColumn = vscodeWrapper.activeTextEditor.viewColumn;
                if (viewColumn === vscode.ViewColumn.One) {
                    viewColumn = vscode.ViewColumn.Two;
                } else {
                    viewColumn = vscode.ViewColumn.Three;
                }
            } else {
                // otherwise take default results column
                viewColumn = vscode.ViewColumn.Two;
            }
    }
    return viewColumn;
}

export function registerCommonRequestHandlers(
    webviewController:
        | QueryResultWebviewController
        | QueryResultWebviewPanelController,
    correlationId: string,
) {
    let webviewViewController: QueryResultWebviewController =
        webviewController instanceof QueryResultWebviewController
            ? webviewController
            : webviewController.getQueryResultWebviewViewController();

    webviewController.registerRequestHandler("getRows", async (message) => {
        const result = await webviewViewController
            .getSqlOutputContentProvider()
            .rowRequestHandler(
                message.uri,
                message.batchId,
                message.resultId,
                message.rowStart,
                message.numberOfRows,
            );
        let currentState = webviewViewController.getQueryResultState(
            message.uri,
        );
        if (
            currentState.isExecutionPlan &&
            // check if the current result set is the result set that contains the xml plan
            currentState.resultSetSummaries[message.batchId][message.resultId]
                .columnInfo[0].columnName === Constants.showPlanXmlColumnName
        ) {
            currentState.executionPlanState.xmlPlans =
                // this gets the xml plan returned by the get execution
                // plan query
                currentState.executionPlanState.xmlPlans.concat(
                    result.rows[0][0].displayValue,
                );
        }
        webviewViewController.setQueryResultState(message.uri, currentState);
        return result;
    });
    webviewController.registerRequestHandler(
        "setEditorSelection",
        async (message) => {
            return await webviewViewController
                .getSqlOutputContentProvider()
                .editorSelectionRequestHandler(
                    message.uri,
                    message.selectionData,
                );
        },
    );
    webviewController.registerRequestHandler("saveResults", async (message) => {
        sendActionEvent(
            TelemetryViews.QueryResult,
            TelemetryActions.SaveResults,
            {
                correlationId: correlationId,
                format: message.format,
                selection: message.selection,
                origin: message.origin,
            },
        );
        return await webviewViewController
            .getSqlOutputContentProvider()
            .saveResultsRequestHandler(
                message.uri,
                message.batchId,
                message.resultId,
                message.format,
                message.selection,
            );
    });
    webviewController.registerRequestHandler(
        "copySelection",
        async (message) => {
            sendActionEvent(
                TelemetryViews.QueryResult,
                TelemetryActions.CopyResults,
                {
                    correlationId: correlationId,
                },
            );
            return await webviewViewController
                .getSqlOutputContentProvider()
                .copyRequestHandler(
                    message.uri,
                    message.batchId,
                    message.resultId,
                    message.selection,
                    false,
                );
        },
    );
    webviewController.registerRequestHandler(
        "copyWithHeaders",
        async (message) => {
            sendActionEvent(
                TelemetryViews.QueryResult,
                TelemetryActions.CopyResultsHeaders,
                {
                    correlationId: correlationId,
                    format: undefined,
                    selection: undefined,
                    origin: undefined,
                },
            );
            return await webviewViewController
                .getSqlOutputContentProvider()
                .copyRequestHandler(
                    message.uri,
                    message.batchId,
                    message.resultId,
                    message.selection,
                    true, //copy headers flag
                );
        },
    );
    webviewController.registerRequestHandler("copyHeaders", async (message) => {
        sendActionEvent(
            TelemetryViews.QueryResult,
            TelemetryActions.CopyHeaders,
            {
                correlationId: correlationId,
            },
        );
        return await webviewViewController
            .getSqlOutputContentProvider()
            .copyHeadersRequestHandler(
                message.uri,
                message.batchId,
                message.resultId,
                message.selection,
            );
    });
    webviewController.registerReducer(
        "setResultTab",
        async (state, payload) => {
            state.tabStates.resultPaneTab = payload.tabId;
            return state;
        },
    );
    webviewController.registerReducer(
        "getExecutionPlan",
        async (state, payload) => {
            // because this is an overridden call, this makes sure it is being
            // called properly
            if ("uri" in payload) {
                const currentResultState =
                    webviewViewController.getQueryResultState(payload.uri);
                if (
                    !(
                        // Check if actual plan is enabled or current result is an execution plan
                        (
                            (currentResultState.actualPlanEnabled ||
                                currentResultState.isExecutionPlan) &&
                            // Ensure execution plan state exists and execution plan graphs have not loaded
                            currentResultState.executionPlanState &&
                            currentResultState.executionPlanState
                                .executionPlanGraphs.length === 0 &&
                            // Check for non-empty XML plans and result summaries
                            currentResultState.executionPlanState.xmlPlans
                                .length &&
                            Object.keys(currentResultState.resultSetSummaries)
                                .length &&
                            // Verify XML plans match expected number of result sets
                            currentResultState.executionPlanState.xmlPlans
                                .length ===
                                webviewViewController.getNumExecutionPlanResultSets(
                                    currentResultState.resultSetSummaries,
                                    currentResultState.actualPlanEnabled,
                                )
                        )
                    )
                ) {
                    return state;
                }

                state = (await createExecutionPlanGraphs(
                    state,
                    webviewViewController.getExecutionPlanService(),
                    currentResultState.executionPlanState.xmlPlans,
                )) as qr.QueryResultWebviewState;
                state.executionPlanState.loadState = ApiStatus.Loaded;
                state.tabStates.resultPaneTab =
                    qr.QueryResultPaneTabs.ExecutionPlan;

                return state;
            }
        },
    );
    webviewController.registerReducer("addXmlPlan", async (state, payload) => {
        state.executionPlanState.xmlPlans = [
            ...state.executionPlanState.xmlPlans,
            payload.xmlPlan,
        ];
        return state;
    });
    webviewController.registerReducer(
        "saveExecutionPlan",
        async (state, payload) => {
            return (await saveExecutionPlan(
                state,
                payload,
            )) as qr.QueryResultWebviewState;
        },
    );
    webviewController.registerReducer("showPlanXml", async (state, payload) => {
        return (await showPlanXml(
            state,
            payload,
        )) as qr.QueryResultWebviewState;
    });
    webviewController.registerReducer("showQuery", async (state, payload) => {
        return (await showQuery(
            state,
            payload,
            webviewViewController.getUntitledDocumentService(),
        )) as qr.QueryResultWebviewState;
    });
    webviewController.registerReducer(
        "updateTotalCost",
        async (state, payload) => {
            return (await updateTotalCost(
                state,
                payload,
            )) as qr.QueryResultWebviewState;
        },
    );
}