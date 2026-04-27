export interface SecretScopeNodeData {
  name: string;
  backendType: "DATABRICKS" | "AZURE_KEYVAULT" | undefined;
  keyvaultMetadata: KeyVaultMetadata | undefined;
  permissions: SecretScopePermission[];
  sourceFile: string;
  sourceLine: number;
  sourceColumn: number;

  referencedByFiles: SecretKeyReference[];
  referencedByTasks: string[];
}

export interface KeyVaultMetadata {
  dnsName: string;
  resourceId: string;
}

export interface SecretScopePermission {
  principal: string;
  permission: "READ" | "WRITE" | "MANAGE";
  principalType: "user" | "group" | "service_principal" | undefined;
}

export interface SecretKeyReference {
  scope: string;
  key: string;
  sourceFile: string;
  sourceLine: number;
  isInBundle: boolean;
}
