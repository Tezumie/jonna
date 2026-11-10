// D265: an API other extensions get from `vscode.extensions.getExtension(id).exports`.
const vscode = require("vscode");

class Counter {
  constructor(start) {
    this.value = start;
  }
  next() {
    this.value++;
    return this.value;
  }
}

function activate(context) {
  const counted = new vscode.EventEmitter();
  let total = 0;
  context.subscriptions.push(counted);
  return {
    version: "2.0",
    home: context.extensionUri,
    add: (a, b) => a + b,
    greet: async (name) => `${name}, from the API`,
    makeCounter: (start) => new Counter(start),
    onDidCount: counted.event,
    count() {
      total++;
      counted.fire(total);
      return total;
    },
  };
}

module.exports = { activate };
