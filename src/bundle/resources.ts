// TODO: minimal version of a secret scope
export interface SecretScope {
  name: string;
  key?: string;
  acls?: string[];
  backend_type?: string;
}
