import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AuthInfo } from "@planning/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ErrorText, Field, useAction } from "../components/ui";
import { apiUrl, configError, isFileMode } from "../config";

export function LoginPage() {
  const { signIn } = useAuth();
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (configError) return setError(configError);
    api.auth
      .info()
      .then(setInfo, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [setError]);

  const submit = () =>
    run(async () => {
      if (info?.setupRequired)
        signIn(
          await api.auth.setup({
            username,
            password,
            displayName: displayName || username,
            email: "",
          }),
        );
      else signIn(await api.auth.login(username, password));
    });

  return (
    <main className="pp-center">
      <form
        className="pp-login"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>Project Planner</h1>
        {info?.setupRequired && (
          <p className="pp-hint">No users yet — create the first administrator.</p>
        )}
        {info?.mode === "sso" ? (
          isFileMode ? (
            <p className="pp-error">
              Single sign-on needs the hosted client. Open the planner from {apiUrl || "the server"}{" "}
              instead.
            </p>
          ) : (
            <a className="pp-button pp-primary" href={api.auth.ssoStartUrl()}>
              Sign in with single sign-on
            </a>
          )
        ) : (
          <>
            <Field label="Username">
              <input
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </Field>
            {info?.setupRequired && (
              <Field label="Display name">
                <input
                  name="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </Field>
            )}
            <Field label="Password">
              <input
                name="password"
                type="password"
                autoComplete={info?.setupRequired ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <button type="submit" className="pp-primary" disabled={busy || !info}>
              {info?.setupRequired ? "Create administrator" : "Sign in"}
            </button>
          </>
        )}
        <ErrorText error={error} />
        {info && <p className="pp-hint">Authentication: {info.mode}</p>}
      </form>
    </main>
  );
}

/** Landing page after an SSO redirect: exchange the one-time code for a token. */
export function AuthCompletePage() {
  const { signIn } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const code = params.get("code");
    if (!code) return setError("Missing login code");
    api.auth.exchange(code).then(
      (result) => {
        signIn(result);
        navigate("/", { replace: true });
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [params, signIn, navigate]);
  return (
    <main className="pp-center">{error ? <ErrorText error={error} /> : <p>Signing in…</p>}</main>
  );
}
