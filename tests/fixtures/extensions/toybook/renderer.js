// An output renderer (D204): draws { "count": n } outputs of application/vnd.toybook.stars+json
// as n stars, tells the extension it drew them, and shows what the extension answers.
export function activate(context) {
  return {
    renderOutputItem(item, element) {
      const { count } = item.json();
      const stars = document.createElement("div");
      stars.className = "toy-stars";
      stars.textContent = "★".repeat(Math.max(0, Math.min(50, Number(count) || 0)));
      const answer = document.createElement("div");
      answer.className = "toy-answer";
      element.append(stars, answer);
      context.onDidReceiveMessage((message) => {
        answer.textContent = String(message && message.text);
      });
      context.postMessage({ drew: count });
      // No network for this renderer (its extension wasn't allowed it).
      fetch("https://example.com/").then(
        () => context.postMessage({ fetched: true }),
        () => context.postMessage({ fetched: false }),
      );
      // Nor the ways around it: WebRTC, a frame of its own (fresh globals), navigating itself.
      const box = document.createElement("div");
      box.innerHTML = "<IFRAME></IFRAME><svg><foreignObject><h:iframe xmlns:h='http://www.w3.org/1999/xhtml'/></foreignObject></svg>";
      element.append(box);
      const made = document.createElement("iframe");
      element.append(made);
      context.postMessage({
        rtc: typeof RTCPeerConnection,
        frames: window.length,
        made: made.tagName.toLowerCase(),
      });
      setTimeout(() => {
        try {
          location.href = "http://localhost:9/leak";
        } catch {
          // Refused outright.
        }
        setTimeout(() => context.postMessage({ stayed: true }), 1500);
      }, 200);
    },
  };
}
