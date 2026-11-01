import type { AppConfig } from "../config/config.js";
import type { UserService } from "../services/UserService.js";
import type { AuthProvider } from "./AuthProvider.js";
import { LdapAuthProvider } from "./LdapAuthProvider.js";
import { LocalAuthProvider } from "./LocalAuthProvider.js";
import { OidcAuthProvider } from "./OidcAuthProvider.js";

export function createAuthProvider(auth: AppConfig["auth"], users: UserService): AuthProvider {
  switch (auth.mode) {
    case "local":
      return new LocalAuthProvider(users);
    case "ldap":
      return new LdapAuthProvider(auth.ldap!, users);
    case "sso":
      if (auth.sso!.protocol === "saml") {
        throw new Error("auth.sso.protocol 'saml' is not implemented yet; use 'oidc'");
      }
      return new OidcAuthProvider(auth.sso!, users);
  }
}
