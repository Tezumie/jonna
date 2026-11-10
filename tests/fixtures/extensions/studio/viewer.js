// The viewer page: shows the file and tells main.js what it got.
const NS = "ide-webview";
addEventListener("message", (e) => {
  if (e.data?.ns !== NS || !e.data.file) return;
  document.getElementById("text").textContent = e.data.file.text ?? e.data.file.error;
  parent.postMessage({ ns: NS, message: { got: e.data.file } }, "*");
});
parent.postMessage({ ns: NS, ready: true }, "*");
