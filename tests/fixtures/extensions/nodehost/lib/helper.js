// A module of its own, loaded with require (the worker can't do that).
exports.shout = (text) => `${String(text).toUpperCase()}!`;
