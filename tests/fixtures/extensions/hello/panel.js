// The page side of a webview panel: messages are { ns: "ide-webview", message }.
const NS = "ide-webview";
const post = (message) => parent.postMessage({ ns: NS, message }, "*");
addEventListener("message", (e) => {
  const data = e.data;
  if (!data || data.ns !== NS) return;
  if (data.theme) {
    for (const [k, v] of Object.entries(data.theme.vars)) document.documentElement.style.setProperty(k, v);
    return;
  }
  document.getElementById("last").textContent = JSON.stringify(data.message);
  if (data.message && data.message.ping !== undefined) post({ pong: data.message.ping + 1 });
});
parent.postMessage({ ns: NS, ready: true }, "*");
