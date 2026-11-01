/**
 * Server-rendered sign-in and consent page for MCP OAuth. It stands alone
 * (no scripts, no external assets) because the browser arrives here from the
 * MCP client, not from the planner's own client.
 */
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function renderAuthorizePage(input: {
  pendingId: string;
  clientName: string;
  redirectHost: string;
  authMode: "local" | "sso" | "ldap";
  error: string | null;
}): string {
  const pending = escape(input.pendingId);
  const signIn =
    input.authMode === "sso"
      ? `<p><a class="primary" href="/oauth/authorize/sso?pending=${encodeURIComponent(input.pendingId)}">Sign in with single sign-on and allow</a></p>
         <form method="post" action="/oauth/authorize/decision">
           <input type="hidden" name="pending" value="${pending}">
           <button type="submit" name="decision" value="deny">Deny</button>
         </form>`
      : `<form method="post" action="/oauth/authorize/decision">
           <input type="hidden" name="pending" value="${pending}">
           <label>Username <input name="username" autocomplete="username" required autofocus></label>
           <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
           <div class="actions">
             <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
             <button type="submit" name="decision" value="approve" class="primary">Sign in and allow</button>
           </div>
         </form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access – Project Planner</title>
<style>
  :root { color-scheme: light dark; --primary: #2f6fde; --border: #c9ced8; --muted: #5b6475; }
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 26rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; }
  .hint { color: var(--muted); font-size: 0.9rem; }
  .error { color: #b42318; }
  label { display: block; margin: 0.7rem 0; }
  input { display: block; width: 100%; box-sizing: border-box; padding: 0.45rem; margin-top: 0.2rem;
          font: inherit; border: 1px solid var(--border); border-radius: 6px; }
  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
  button, a.primary { font: inherit; padding: 0.45rem 0.9rem; border-radius: 6px; border: 1px solid var(--border);
                      background: transparent; color: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
  .primary { background: var(--primary) !important; border-color: var(--primary) !important; color: #fff !important; }
</style>
</head>
<body>
<main>
  <h1>Allow ${escape(input.clientName)} to use Project Planner?</h1>
  <p>It will act as you through MCP: read the projects and plans you have access to, change tasks and propose changes. Approvals stay in the planner.</p>
  <p class="hint">After you allow it, you return to <b>${escape(input.redirectHost)}</b>. Only continue if you started this from that client.</p>
  ${input.error ? `<p class="error" role="alert">${escape(input.error)}</p>` : ""}
  ${signIn}
</main>
</body>
</html>`;
}
