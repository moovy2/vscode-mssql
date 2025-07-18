/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    downloadAndUnzipVSCode,
    resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { _electron as electron } from "playwright";
import * as path from "path";
import { ElectronApplication, Page } from "@playwright/test";
import { getVsCodeVersionName } from "./envConfigReader";
import * as cp from "child_process";

export type mssqlExtensionLaunchConfig = {
    /**
     * Indicates whether to use the new UI for the MSSQL extension.
     *
     * If `true`, launches VS Code with the new webview-based UI.
     * If `false`, falls back to the legacy command-prompt-based UI.
     *
     * Ideally, the extension should be launched with the new UI to test the latest features.
     * Defaults to `true`.
     */
    useNewUI?: boolean;
    /**
     * Indicates whether to use the VSIX package for the MSSQL extension.
     *
     * If `true`, the VSIX is installed in VS Code before running Playwright tests.
     * If `false`, VS Code is launched with the extension loaded directly from the development source path.
     *
     * Ideally, this should be set to `false` to run tests directly against source files for faster execution.
     * Defaults to `false`.
     */
    useVsix?: boolean;
};

export async function launchVsCodeWithMssqlExtension(
    options: mssqlExtensionLaunchConfig = {},
): Promise<{
    electronApp: ElectronApplication;
    page: Page;
}> {
    options = {
        useNewUI: true,
        useVsix: false,
        ...options,
    };
    const vsCodeVersionName = getVsCodeVersionName();
    const vsCodeExecutablePath = await downloadAndUnzipVSCode(vsCodeVersionName);
    const [cliPath, extensionDir] = resolveCliArgsFromVSCodeExecutablePath(vsCodeExecutablePath);

    const mssqlExtensionDevPath = path.resolve(__dirname, "../../../");

    const userDataArg = !options.useNewUI
        ? `--user-data-dir=${path.join(process.cwd(), "test", "resources", "launchDir")}`
        : "";

    const vscodeLaunchArgs = [
        "--disable-gpu-sandbox", // https://github.com/microsoft/vscode-test/issues/221
        "--disable-updates", // https://github.com/microsoft/vscode-test/issues/120
        "--new-window", // Opens a new session of VS Code instead of restoring the previous session (default).
        "--no-sandbox", // https://github.com/microsoft/vscode/issues/84238
        "--skip-release-notes",
        "--skip-welcome",
        extensionDir,
        userDataArg,
    ];

    if (options.useVsix) {
        const vsixPath = process.env["BUILT_VSIX_PATH"];
        if (!vsixPath) {
            throw new Error("BUILT_VSIX_PATH environment variable is not set.");
        }
        console.log(`Installing extension from VSIX: ${vsixPath}`);
        const result = cp.spawnSync(
            cliPath,
            [extensionDir, userDataArg, "--install-extension", vsixPath],
            {
                encoding: "utf-8",
                stdio: "pipe", // capture output for inspection
            },
        );

        console.log("stdout:", result.stdout);
        console.log("stderr:", result.stderr);
        console.log("status:", result.status);
        if (result.error) {
            console.error("error:", result.error);
        }
    } else {
        console.log("Launching with extension development path.");
        vscodeLaunchArgs.push(
            `--profile-temp`, // Use a temporary profile to avoid conflicts with existing profiles
            `--disable-extensions`, // Disable all extensions except the one we are testing
            `--extensionDevelopmentPath=${mssqlExtensionDevPath}`, // Path to the extension being developed
        );
    }

    const electronApp = await electron.launch({
        executablePath: vsCodeExecutablePath,
        args: vscodeLaunchArgs,
    });

    const page = await electronApp.firstWindow({
        timeout: 10 * 1000, // 10 seconds
    });

    // Open SQL Server extension tab if not already selected
    const sqlServerTabContainer = page.locator('[role="tab"][aria-label^="SQL Server"]');
    const isSelected = await sqlServerTabContainer.getAttribute("aria-selected");

    if (isSelected !== "true") {
        const sqlServerTabElement = sqlServerTabContainer.locator("a");
        await sqlServerTabElement.waitFor({ state: "visible", timeout: 30 * 1000 });
        await sqlServerTabElement.click();
    }

    // Wait for Object Explorer to load
    const objectExplorerProviderElement = page
        .getByText("There is no data provider registered that can provide view data.")
        .first();
    await objectExplorerProviderElement.waitFor({
        state: "hidden",
        timeout: 30 * 1000,
    });

    // Ensure the extension has loaded by checking object explorer has loaded
    const objectExplorerElement = page.locator('[role="treeitem"][aria-label*="Add Connection"]');
    await objectExplorerElement.waitFor({
        state: "visible",
        timeout: 30 * 1000,
    });

    return { electronApp, page };
}
