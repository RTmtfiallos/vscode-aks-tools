import * as vscode from 'vscode';
import * as k8s from 'vscode-kubernetes-tools-api';
import { IActionContext } from 'vscode-azureextensionui';
import * as tmpfile from '../utils/tempfile';
import * as clusters from '../utils/clusters';
import { getExtensionPath, longRunning } from '../utils/host';
import {
    getClusterDiagnosticSettings,
    chooseStorageAccount,
    getStorageInfo,
    prepareAKSPeriscopeDeploymetFile,
    generateDownloadableLinks,
    getWebviewContent
} from './helpers/periscopehelper';
import { PeriscopeStorage } from './models/storage';
import AksClusterTreeItem from '../../tree/aksClusterTreeItem';

export default async function periscope(
    context: IActionContext,
    target: any
): Promise<void> {
    const kubectl = await k8s.extension.kubectl.v1;
    const cloudExplorer = await k8s.extension.cloudExplorer.v1;

    if (cloudExplorer.available && kubectl.available) {
        const clusterTarget = cloudExplorer.api.resolveCommandTarget(target);

        if (clusterTarget && clusterTarget.cloudName === "Azure" &&
            clusterTarget.nodeType === "resource" && clusterTarget.cloudResource.nodeType === "cluster") {
            const cluster = clusterTarget.cloudResource as AksClusterTreeItem;
            const clusterKubeConfig = await clusters.getKubeconfigYaml(cluster);

            if (clusterKubeConfig) {
                await runAKSPeriscope(cluster, clusterKubeConfig);
            }
        } else {
            vscode.window.showInformationMessage('This command only applies to AKS clusters.');
        }
    }
}

async function runAKSPeriscope(
    cluster: AksClusterTreeItem,
    clusterKubeConfig: string
): Promise<void> {
    const clusterName = cluster.name;

    // Get Diagnostic settings for cluster and get associated storage account information.
    const clusterDiagnosticSettings = await longRunning(`Identifying cluster diagnostic settings.`,
        () => getClusterDiagnosticSettings(cluster)
    );

    if (!clusterDiagnosticSettings || !clusterDiagnosticSettings.value?.length) {
        // If there is no storage account attached to diagnostic setting, don't move forward and at this point we will render webview with helpful content.
        await createPeriscopeWebView(cluster.name, undefined, undefined, false);
        return undefined;

    }

    const clusterStorageAccountId = await chooseStorageAccount(clusterDiagnosticSettings);

    // Generate storage sas keys, manage aks persicope run.
    if (!clusterStorageAccountId) return undefined;

    const clusterStorageInfo = await longRunning(`Generating SAS for ${clusterName} cluster.`,
        () => getStorageInfo(cluster, clusterStorageAccountId, clusterKubeConfig)
    );

    if (!clusterStorageInfo) return undefined;

    const aksDeploymentFile = await longRunning(`Deploying AKS Periscope to ${clusterName}.`,
        () => prepareAKSPeriscopeDeploymetFile(clusterStorageInfo)
    );

    if (!aksDeploymentFile) return undefined;

    const runCommandResult = await longRunning(`Running AKS Periscope on ${clusterName}.`,
        () => runAssociatedAKSPeriscopeCommand(aksDeploymentFile, clusterKubeConfig)
    );

    await createPeriscopeWebView(clusterName, runCommandResult, clusterStorageInfo);

}

async function runAssociatedAKSPeriscopeCommand(
    aksPeriscopeFile: string,
    clusterKubeConfig: string | undefined
): Promise<k8s.KubectlV1.ShellResult | undefined> {
    const kubectl = await k8s.extension.kubectl.v1;

    if (!kubectl.available) {
        vscode.window.showWarningMessage(`Kubectl is unavailable.`);
        return undefined;
    }

    // Clean up running instance.
    await tmpfile.withOptionalTempFile<k8s.KubectlV1.ShellResult | undefined>(
        clusterKubeConfig, "YAML",
        (f) => kubectl.api.invokeCommand(`delete ns aks-periscope --kubeconfig="${f}"`));

    // Deploy the aks-periscope.
    const runCommandResult = await tmpfile.withOptionalTempFile<k8s.KubectlV1.ShellResult | undefined>(
        clusterKubeConfig, "YAML",
        (f) => kubectl.api.invokeCommand(`apply -f ${aksPeriscopeFile} --kubeconfig="${f}" && kubectl cluster-info --kubeconfig="${f}"`));

    return runCommandResult;
}

async function createPeriscopeWebView(
    clusterName: string,
    outputResult: k8s.KubectlV1.ShellResult | undefined,
    periscopeStorageInfo: PeriscopeStorage | undefined,
    hasDiagnosticSettings = true
): Promise<void | undefined> {
    const panel = vscode.window.createWebviewPanel(
        `AKS Periscope`,
        `AKS Periscope: ${clusterName}`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            enableCommandUris: true
        }
    );

    const extensionPath = getExtensionPath();

    if (!extensionPath) {
        return undefined;
    }

    if (!hasDiagnosticSettings) {
        // In case of no diagnostic setting we serve user with helpful content in webview and
        // a link as to how to attach the storage account to cluster's diagnostic settings.
        panel.webview.html = getWebviewContent(clusterName, extensionPath, outputResult, undefined, [], hasDiagnosticSettings);
        return undefined;
    }

    if (periscopeStorageInfo) {
        // For the case of successful run of the tool we render webview with the output information.
        panel.webview.html = getWebviewContent(clusterName, extensionPath, outputResult, periscopeStorageInfo, []);

        panel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === "generateDownloadLink") {
                    // Generate link mechanism is in place due to current behaviour of the aks-periscope tool. (which seems by design for now)
                    // more detail here: https://github.com/Azure/aks-periscope/issues/30
                    const downloadableAndShareableNodeLogsList = await longRunning(`Generating links to Periscope logs.`,
                        () => generateDownloadableLinks(periscopeStorageInfo)
                    );

                    panel.webview.html = getWebviewContent(clusterName, extensionPath, outputResult, periscopeStorageInfo, downloadableAndShareableNodeLogsList);
                }

            },
            undefined
        );
    }
}
