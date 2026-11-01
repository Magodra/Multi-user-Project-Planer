// Client deployment configuration (see CLAUDE.md "Client deployment modes").
// Leave apiUrl empty when the client is served by the planning server itself.
// When index.html is opened from the file system, set it to the server URL,
// e.g. "https://planning.example.com", and enable server.allowFileClient.
window.PLANNING_CLIENT_CONFIG = {
  apiUrl: "",
};
